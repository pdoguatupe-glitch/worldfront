# WorldFront

Jogo de estratégia geopolítica em português, com mapa mundial interativo, campanha solo contra IA e salas multiplayer sincronizadas em tempo real.

## Recursos

- Mapa mundial vetorial com zoom, seleção de países e fronteiras.
- Campanhas solo, salas online, lobby, chat e atualização por Socket.IO.
- Simulação no servidor: economia, construções, recrutamento, pesquisa, diplomacia, comércio, espionagem, guerra, combate, conquista e movimentos entre turnos.
- IA, Fog of War, eventos mundiais, condições de vitória, perfil e ranking.
- Persistência PostgreSQL em produção e JSON local durante desenvolvimento.

## Tecnologias

- Frontend: React, TypeScript, Vite, D3 Geo, World Atlas e Socket.IO Client.
- API e realtime: Node.js, TypeScript, Express, Socket.IO, Zod e PostgreSQL.
- Dados geográficos: pacotes `world-atlas`, `world-countries` e `country-json`; consulte as licenças dos pacotes para créditos.

## Executar localmente

Requer Node.js 20.19+ ou 22.12+ e npm.

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

Abra <http://localhost:5173>. A API local fica em <http://localhost:3001>. Sem `DATABASE_URL`, o estado de desenvolvimento é salvo em `backend/data/worldfront.json` (ignorado pelo Git). Single Player também depende da API.

## Publicação gratuita

Arquitetura prevista: frontend estático no GitHub Pages, API Socket.IO em Render e PostgreSQL no Supabase. O banco conserva perfis e partidas quando o serviço web gratuito hiberna ou reinicia. Os provedores impõem limites e podem pausar serviços gratuitos; consulte os links oficiais antes de publicar para confirmar as condições vigentes.

### 1. Criar o banco Supabase

Crie um projeto no plano Free e copie a URI de conexão PostgreSQL (use uma conexão apropriada para aplicações persistentes; guarde usuário e senha como segredo). A primeira inicialização da API executa `backend/migrations/001_initial.sql`. A tabela contém estado do jogo em JSONB; os tokens de sessão são armazenados como hashes.

### 2. Criar a API Render

Importe este repositório no Render. O arquivo `render.yaml` define build, inicialização e health check. Configure no serviço:

- `DATABASE_URL`: URI do banco Supabase, como segredo privado.
- `FRONTEND_ORIGINS`: origem exata do Pages, por exemplo `https://USUARIO.github.io` (mesma origem para sites de projeto sob `/REPOSITORIO`). Separe origens adicionais por vírgula.

O serviço também define `NODE_ENV=production`; nessa condição a API recusa iniciar sem `DATABASE_URL`. Após o deploy, confirme `https://SEU-SERVICO.onrender.com/health` e `/api/health`.

### 3. Publicar no GitHub Pages

No repositório GitHub, abra **Settings → Pages** e escolha **GitHub Actions** como fonte. Em **Settings → Secrets and variables → Actions → Variables**, adicione:

- `VITE_API_URL`: URL HTTPS base da API Render, sem `/api` no final.
- `VITE_SOCKET_URL`: opcional; normalmente pode usar a mesma URL da API.

Faça push para `main` ou execute manualmente o workflow **Publish frontend to GitHub Pages**. O workflow calcula a base do site automaticamente para repositórios de projeto e repositórios `*.github.io`.

### 4. CORS

Defina `FRONTEND_ORIGINS` no Render com a origem do site Pages. Uma configuração errada impede chamadas da API e do Socket.IO. Após mudar a URL do Pages, atualize a variável e redeploye a API.

## Desenvolvimento, testes e build

```powershell
npm test
npm run test:realtime -w backend
npm run build
```

O teste unitário cobre catálogo, persistência local, economia, combate, diplomacia, pesquisa e confidencialidade da interface secreta. O teste de integração exercita dois clientes Socket.IO autenticados, lobby, sincronização de turno, chat e saída.

## Rotas principais

- `GET /health` e `/api/health`
- `GET /api/countries`, `/api/rules`, `/api/ranking`
- `POST /api/players/guest`, `GET/PATCH /api/profile`
- `GET/POST /api/rooms`, `POST /api/rooms/:id/join`, `DELETE /api/rooms/:id/leave`
- `PATCH /api/rooms/:id/country`, `/ready`; `POST /api/rooms/:id/start`
- `POST /api/singleplayer`, `GET /api/rooms/:id`, `POST /api/rooms/:id/actions`, `/chat`, `/forfeit`

Rotas de perfil, salas e ações exigem `Authorization: Bearer <token>`. O servidor valida e calcula as ações; eventos de estado são filtrados conforme Fog of War.

## Limites do plano gratuito

Render Free pode hibernar serviços web ociosos, causando atraso na primeira requisição, e não mantém arquivos locais entre reinícios; por isso produção exige PostgreSQL externo. Supabase Free pode pausar projetos sem atividade e tem cotas menores do que planos pagos. Hibernação ou pausa deixa a partida temporariamente indisponível. Faça exportações regulares do estado se os dados forem importantes. Multiplayer e campanha solo precisam da API online; o site estático sozinho não roda uma partida offline.

## Variáveis de ambiente

Veja `.env.example`. Backend: `NODE_ENV`, `HOST`, `PORT`, `FRONTEND_ORIGINS`, `DATABASE_URL` e `DATA_DIR` (apenas JSON local). Frontend: `VITE_API_URL`, `VITE_SOCKET_URL` e `VITE_BASE_PATH`. Nunca coloque segredos de banco ou tokens em variáveis `VITE_*`, que são incorporadas ao JavaScript público.
