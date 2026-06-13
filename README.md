# 🎖️ Invite Tracker — Sistema de Controle de Convites Discord

Sistema completo para rastrear convites em servidores do Discord, com painel web, API REST e bot integrado.

---

## 📁 Estrutura de Pastas

```
invite-system/
├── backend/
│   ├── server.js          ← API REST + servidor web
│   ├── package.json
│   ├── .env.example
│   └── invites.db         ← Gerado automaticamente (SQLite)
│
├── frontend/
│   └── public/
│       └── index.html     ← SPA completo (servido pelo backend)
│
└── bot/
    ├── bot.js             ← Bot do Discord
    ├── register-commands.js ← Registrar slash commands (1x)
    ├── package.json
    └── .env.example
```

---

## 🚀 Como Rodar

### 1. Backend

```bash
cd backend
cp .env.example .env
# Edite .env com sua senha admin
npm install
npm start
# Acesse: http://localhost:3000
```

### 2. Bot do Discord

```bash
cd bot
cp .env.example .env
# Edite .env com seu BOT_TOKEN e CLIENT_ID
npm install
node register-commands.js   # Apenas uma vez
npm start
```

---

## ⚙️ Configuração do Bot (.env)

```env
BOT_TOKEN=seu_token_aqui
CLIENT_ID=id_da_aplicacao_discord
BACKEND_URL=http://localhost:3000
ADMIN_SECRET=mesma_senha_do_backend
LOG_CHANNEL_ID=id_do_canal_de_log   # opcional
```

---

## 🤖 Configuração no Discord Developer Portal

1. Acesse https://discord.com/developers/applications
2. Crie uma nova Application → "New Application"
3. Vá em **Bot** → "Add Bot"
4. Copie o **Token** → coloque em `BOT_TOKEN`
5. Copie o **Application ID** → coloque em `CLIENT_ID`
6. Em **Privileged Gateway Intents**, ative:
   - ✅ SERVER MEMBERS INTENT
   - ✅ GUILD INVITES (automático via permissões)
7. Para convidar o bot ao servidor, vá em **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Permissions: `Manage Guild`, `View Channels`, `Send Messages`, `Embed Links`

---

## 📡 API Endpoints

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/invites` | Registrar novo membro (bot usa isso) |
| GET | `/api/stats` | Stats do dashboard |
| GET | `/api/invites/ranking` | Ranking geral |
| GET | `/api/invites/ranking/monthly` | Ranking mensal |
| GET | `/api/invites/history` | Histórico paginado |
| GET | `/api/user/:userId` | Perfil de usuário |
| GET | `/api/admin/logs` | Logs do sistema *(admin)* |
| POST | `/api/admin/reset/:userId` | Zerar convites *(admin)* |
| POST | `/api/admin/set-invites` | Ajuste manual *(admin)* |
| DELETE | `/api/admin/member/:userId` | Remover membro *(admin)* |

Rotas admin exigem header: `x-admin-secret: sua_senha`

---

## 🌐 Deploy em VPS (Ubuntu 24.04)

### Instalar Node.js
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### PM2 (processo em background)
```bash
npm install -g pm2

# Backend
cd /var/www/invite-system/backend
pm2 start server.js --name invite-backend

# Bot
cd /var/www/invite-system/bot
pm2 start bot.js --name invite-bot

pm2 save
pm2 startup
```

### Nginx + HTTPS
```nginx
server {
    listen 80;
    server_name seudominio.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
    }
}
```

```bash
sudo certbot --nginx -d seudominio.com
```

---

## 🔒 Segurança

- Mude o `ADMIN_SECRET` para uma senha forte em produção
- Nunca exponha o `.env` publicamente
- O bot usa intents privilegiados — mantenha o token seguro

---

## 🧩 Slash Commands do Bot

| Comando | Descrição |
|---------|-----------|
| `/ranking` | Mostra top 10 recrutadores |
| `/meurank` | Mostra seu perfil (privado) |
