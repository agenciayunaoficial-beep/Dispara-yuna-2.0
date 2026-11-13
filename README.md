# Dispara Yuna

Disparo agendado de mensagens no WhatsApp (Node.js + whatsapp-web.js + Socket.io).

## O que faz
- **Conexões**: você cria uma conexão por cliente e envia o **link exclusivo** (`/c/xxxx`). O cliente abre, escolhe **QR Code** ou **código de pareamento** e conecta o próprio WhatsApp.
- **Sincroniza os contatos** automaticamente ao conectar (só contatos salvos na agenda; grupos ficam de fora).
- **Campanhas**: texto + foto/vídeo/PDF opcional, para todos os contatos, só alguns escolhidos, e/ou números extras colados.
- **Agendamento**: dia de início + **horário que começa** + **horário que encerra**. Fora do horário o envio pausa sozinho e continua no dia seguinte de onde parou.
- **Intervalo aleatório** entre mensagens (padrão 20–60 s), `{nome}` e variações `{oi|olá|e aí}`.
- **Desconectar WhatsApp**: botão no painel (faz logout do aparelho, apaga a sessão e pausa as campanhas). Cada campanha também tem Pausar/Retomar.
- Pausa automática após 5 falhas seguidas.

## Hospedagem: use o Railway (não a Vercel)
A Vercel é "serverless": cada requisição roda e morre. O WhatsApp precisa de um **processo ligado 24h** com um navegador aberto e a sessão salva em disco, então **não funciona na Vercel**. No Railway funciona.

### Passo a passo no Railway
1. Suba esta pasta para um repositório no GitHub (pode ser privado).
2. Railway → **New Project → Deploy from GitHub repo** (ele detecta o `Dockerfile`).
3. Aba **Variables**: `ADMIN_PASSWORD` = senha forte do painel. (Opcional: `APP_TZ=America/Maceio`.)
4. Aba **Settings → Volumes → New Volume**, ponto de montagem **`/data`**. *Sem isso a sessão do WhatsApp e as campanhas somem a cada deploy.*
5. **Settings → Networking → Generate Domain**. O painel fica nesse endereço.
6. Memória: cada WhatsApp conectado abre um Chromium (~300–500 MB). Para 1–2 clientes o plano Hobby serve; para mais, aumente a RAM.

## Rodar no computador (teste)
```
npm install
set ADMIN_PASSWORD=suasenha   (Windows)   |   export ADMIN_PASSWORD=suasenha
npm start
```
Abra http://localhost:3000. Localmente precisa de Google Chrome instalado; defina `PUPPETEER_EXECUTABLE_PATH` com o caminho do `chrome.exe`.

## Avisos importantes
- O WhatsApp **não permite oficialmente** disparo em massa por contas comuns; números podem ser **banidos**. Reduza o risco: mande só para quem conhece/espera sua mensagem, use intervalos longos (30–90 s), limite o volume por dia, varie o texto com `{nome}` e `{a|b}`, e evite números novos.
- Para volume alto e sem risco de banimento, o caminho oficial é a **WhatsApp Business API (Cloud API)**.
- Avise o cliente que ele está autorizando o envio pelo número dele.
