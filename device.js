#!/usr/bin/env node
/**
 * controlid-fake-device — um relógio de ponto Control iD de mentira.
 *
 * POR QUE EXISTE
 *
 * Sistema de controle de ponto não se testa sem relógio: as rotinas que leem
 * biometria do equipamento só rodam quando alguém do outro lado ATENDE. Isso
 * prende o desenvolvimento a ter um aparelho na mesa, na mesma rede.
 *
 * Este programa é o aparelho. Ele escuta HTTP e responde as mesmas chamadas
 * `.fcgi` (mode=671) que um iDClass responderia. Quem fala com ele não precisa
 * saber que é mentira.
 *
 * O QUE ELE RESPONDE
 *
 * O necessário para cadastro e leitura de biometria: `login`, `load_users`,
 * `add_users`, `update_users`, `remove_users`, `get_system_information` e
 * `get_afd`.
 *
 * O ROTEIRO (é o ponto principal)
 *
 * Um simulador que sempre responde "deu certo" não testa nada. Para exercitar
 * os três desfechos possíveis de uma leitura, a resposta varia pelo ÚLTIMO
 * dígito do CPF — assim uma lista de pessoas reais já produz os três casos sem
 * nenhuma configuração:
 *
 *   final 0 a 5  →  devolve 2 digitais   →  leitura com biometria
 *   final 6 a 8  →  devolve nenhuma      →  pessoa sem digital no aparelho
 *   final 9      →  responde erro        →  falha de comunicação
 *
 * O caso do meio é o que costuma faltar nos testes: o equipamento respondeu
 * normalmente, a pessoa é que nunca cadastrou o dedo nele. Tratar isso como
 * erro é o defeito clássico desse tipo de integração.
 *
 * As "digitais" são texto inventado. Para o software a digital é uma cadeia
 * opaca que ele guarda e devolve — não a imagem do dedo. Serve para testar
 * fluxo, contagem e estados de tela; NÃO serve para validar biometria de
 * verdade, que exige dedo e aparelho.
 *
 * USO
 *
 *   node device.js                       # escuta em 127.0.0.1:8890
 *   FAKE_PORT=9000 node device.js
 *   FAKE_CPFS="111...,222..." node device.js   # quem está "cadastrado"
 *   FAKE_ALL_SAVED=1 node device.js      # todo mundo com digital
 *   FAKE_ALL_EMPTY=1 node device.js      # ninguém com digital
 *
 * ATENÇÃO: muitos sistemas de ponto não falam direto com o relógio — falam com
 * um agente comunicador que fica no meio. Nesse caso, aponte o agente para o
 * endereço deste programa em vez de apontá-lo para um aparelho.
 */

'use strict';

const http = require('http');

const cfg = {
  port: Number(process.env.FAKE_PORT || 8890),
  host: process.env.FAKE_HOST || '127.0.0.1',
  login: process.env.FAKE_LOGIN || 'admin',
  password: process.env.FAKE_PASSWORD || 'admin',
  allSaved: process.env.FAKE_ALL_SAVED === '1',
  allEmpty: process.env.FAKE_ALL_EMPTY === '1',
  /**
   * CPFs que este "aparelho" tem cadastrados. Quem lista o equipamento inteiro
   * costuma cruzar a resposta pelo CPF, então aqui vão os CPFs das pessoas que
   * o sistema espera encontrar neste relógio.
   */
  cpfs: (process.env.FAKE_CPFS || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean),
};

const SESSION = 'fake-session-0001';

const log = (msg) => console.log(`[device] ${msg}`);

/**
 * Template de mentira. O formato real é um ICRS21 em base64; aqui basta ser
 * uma cadeia estável e distinguível, porque nada neste caminho interpreta o
 * conteúdo — o backend só conta, guarda e devolve.
 *
 * O prefixo FAKE deixa óbvio na inspeção do banco que o dado é de teste. Note
 * que NÃO começa com `DEVICE_IMPORT:`, senão o backend o descartaria como
 * marcador legado.
 */
function fakeTemplate(cpf, indice) {
  const base = `FAKE-TEMPLATE:${cpf}:${indice}:`;
  return Buffer.from(base + 'x'.repeat(220)).toString('base64');
}

/** Quantas digitais este CPF tem no "aparelho", e se a leitura falha. */
function roteiroPara(cpf) {
  if (cfg.allSaved) return { templates: 2, falha: false };
  if (cfg.allEmpty) return { templates: 0, falha: false };

  const ultimo = Number(String(cpf ?? '').slice(-1));
  if (!Number.isFinite(ultimo)) return { templates: 0, falha: false };
  if (ultimo === 9) return { templates: 0, falha: true };
  if (ultimo >= 6) return { templates: 0, falha: false };
  return { templates: 2, falha: false };
}

function usuarioFalso(cpf) {
  const { templates } = roteiroPara(cpf);
  return {
    id: Number(String(cpf).slice(-6)) || 1,
    name: `COLABORADOR ${cpf}`,
    cpf: Number(cpf),
    registration: Number(String(cpf).slice(-5)) || 0,
    password: '',
    // O adapter do backend lê este campo como digitBiometricTemplates.
    templates: Array.from({ length: templates }, (_, i) =>
      fakeTemplate(cpf, i),
    ),
    // SEM image_timestamp de propósito: este aparelho não guarda foto. Anunciar
    // uma e não entregar faz o backup em massa falhar com "O equipamento
    // informou uma foto, mas não devolveu seu conteúdo" — o backend confere.
  };
}

function responder(res, status, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(texto),
  });
  res.end(texto);
}

function tratar(caminho, corpo, res) {
  // O caminho vem como /comando.fcgi?session=...&mode=671
  const comando = caminho.replace(/^\//, '').replace(/\.fcgi.*$/, '');

  if (comando === 'login') {
    if (corpo.login !== cfg.login || corpo.password !== cfg.password) {
      log(`login recusado (${corpo.login})`);
      return responder(res, 401, { error: 'Invalid credentials' });
    }
    log('login aceito');
    return responder(res, 200, { session: SESSION });
  }

  if (comando === 'load_users') {
    const pedidos = Array.isArray(corpo.users_cpf) ? corpo.users_cpf : null;

    if (pedidos) {
      const cpf = String(pedidos[0]).padStart(11, '0');
      const { falha, templates } = roteiroPara(cpf);
      if (falha) {
        log(`load_users cpf=${cpf} -> erro de propósito (roteiro)`);
        return responder(res, 500, {
          error: 'Device busy: fingerprint sensor not responding',
        });
      }
      log(`load_users cpf=${cpf} -> ${templates} digital(is)`);
      return responder(res, 200, { users: [usuarioFalso(cpf)] });
    }

    // Lista inteira (READ_PAGE do backup em massa). O backend cruza a resposta
    // pelo CPF, então estes têm de ser os CPFs reais dos colaboradores
    // associados a este relógio — senão ele não acha ninguém e o backup
    // termina com zero. Passe-os em FAKE_CPFS, separados por vírgula.
    const offset = Number(corpo.offset ?? 0);
    const pagina = cfg.cpfs.slice(offset, offset + Number(corpo.limit ?? 100));
    log(`load_users (lista) offset=${offset} -> ${pagina.length} usuários`);
    return responder(res, 200, { users: pagina.map(usuarioFalso) });
  }

  if (comando === 'get_system_information') {
    return responder(res, 200, {
      device: 'iDClass Bio',
      serial: 'FAKE-0001',
      version: '6.47.0-fake',
    });
  }

  if (comando === 'get_afd') {
    // Sem batidas: o teste aqui é de biometria, não de ponto.
    return responder(res, 200, { afd: '' });
  }

  if (['add_users', 'update_users', 'remove_users'].includes(comando)) {
    const quantos = (corpo.users ?? []).length;
    log(`${comando} -> ${quantos} usuário(s), aceito`);
    return responder(res, 200, {});
  }

  if (comando === 'set_user_image' || comando === 'user_set_image') {
    log('set_user_image -> aceito');
    return responder(res, 200, {});
  }

  log(`comando não implementado: ${comando}`);
  return responder(res, 404, { error: `unknown command: ${comando}` });
}

const servidor = http.createServer((req, res) => {
  let bruto = '';
  req.on('data', (pedaco) => {
    bruto += pedaco;
    // Um device real tem memória curta; aqui o limite só evita engasgo.
    if (bruto.length > 8 * 1024 * 1024) req.destroy();
  });
  req.on('end', () => {
    let corpo = {};
    try {
      corpo = bruto ? JSON.parse(bruto) : {};
    } catch {
      // Foto vai como binário puro em algumas rotas; não é erro.
      corpo = {};
    }
    try {
      tratar(req.url || '/', corpo, res);
    } catch (erro) {
      log(`erro ao tratar ${req.url}: ${erro.message}`);
      responder(res, 500, { error: erro.message });
    }
  });
});

servidor.listen(cfg.port, cfg.host, () => {
  log(`Control iD de mentira escutando em http://${cfg.host}:${cfg.port}`);
  log(`credencial: ${cfg.login}/${cfg.password}`);
  if (cfg.allSaved) log('modo: TODO MUNDO com digital');
  else if (cfg.allEmpty) log('modo: NINGUÉM com digital');
  else
    log(
      'roteiro pelo último dígito do CPF: 0-5 tem digital, 6-8 não tem, 9 falha',
    );
});
