# controlid-fake-device

Um relógio de ponto **Control iD de mentira**, para testar integração de
biometria sem ter o aparelho na mesa.

Fala a API `.fcgi` (mode=671) do iDClass por HTTP. Quem conversa com ele não
precisa saber que é mentira.

## O problema que ele resolve

Rotinas que leem biometria do relógio só rodam quando alguém do outro lado
atende. Sem equipamento, o código não executa: ou o job fica esperando
conexão, ou falha por timeout. Isso prende o desenvolvimento a ter um aparelho
disponível, na mesma rede.

E tem um caso que quase nunca é testado, porque é chato de reproduzir de
propósito: **o equipamento responde normalmente, mas aquela pessoa não tem
digital cadastrada nele**. Não é falha de comunicação, não é sucesso. Tratar
isso como erro é o defeito clássico dessas integrações — o usuário vê "falhou"
e vai atrás de um problema de rede que não existe.

## Como ele força os três casos

A resposta varia pelo **último dígito do CPF**, então uma lista de pessoas real
já produz os três desfechos sem configurar nada:

| Final do CPF | Responde | Representa |
|---|---|---|
| 0 a 5 | 2 digitais | leitura com biometria |
| 6 a 8 | nenhuma digital | pessoa sem dedo cadastrado no aparelho |
| 9 | HTTP 500 | falha de comunicação |

## Uso

Precisa só de Node.js. Sem dependências.

```bash
node device.js
```

Sobe em `127.0.0.1:8890`, credencial `admin`/`admin`.

```bash
# porta e credencial
FAKE_PORT=9000 FAKE_LOGIN=root FAKE_PASSWORD=1234 node device.js

# quem este aparelho "tem cadastrado" (afeta a listagem completa)
FAKE_CPFS="12345678901,98765432100" node device.js

# atalhos para cenário único
FAKE_ALL_SAVED=1 node device.js   # todo mundo com digital
FAKE_ALL_EMPTY=1 node device.js   # ninguém com digital
```

Teste rápido:

```bash
curl -s -X POST http://127.0.0.1:8890/login.fcgi \
  -H 'Content-Type: application/json' \
  -d '{"login":"admin","password":"admin"}'
# {"session":"fake-session-0001"}
```

## Comandos atendidos

| Comando | O que faz |
|---|---|
| `login` | devolve uma sessão fixa; recusa credencial errada com 401 |
| `load_users` | lista todos, ou um por `users_cpf`, com `templates` |
| `add_users` / `update_users` / `remove_users` | aceitam e confirmam |
| `get_system_information` | identificação do "aparelho" |
| `get_afd` | AFD vazio |
| `set_user_image` | aceita e confirma |

Comando não implementado devolve 404 dizendo qual foi — então, se o seu
sistema precisar de outro, o log aponta na hora.

## Duas armadilhas que ele reproduz de propósito

**Não anuncia foto.** `image_timestamp` fica de fora da resposta. Um aparelho
que informa ter foto e depois não entrega o conteúdo faz a importação falhar —
é um erro legítimo, e o simulador não deve tropeçar nele sem querer.

**Templates não parecem válidos por acaso.** O texto devolvido começa com
`FAKE-TEMPLATE:`. Em nenhum momento ele se confunde com um ICRS21 de verdade,
e dá para achar o dado de teste no banco depois com um `LIKE`.

## Se o seu sistema usa um agente comunicador

Muitos sistemas de ponto não falam direto com o relógio: falam com um agente
que fica no meio da rede. Nesse caso, aponte **o agente** para o endereço deste
programa, em vez de apontá-lo para um aparelho:

```
seu backend  →  agente comunicador  →  HTTP  →  controlid-fake-device
```

## Limites

Testa fluxo, contagem e estados de tela. **Não** valida biometria: a digital
aqui é texto inventado, não um template real. Conferir se uma digital funciona
mesmo exige dedo e aparelho.

## Licença

MIT
