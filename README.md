# Mohr Insurance Sales Training Simulator

Voice-based training tool where Medicare sales agents practice calls against AI personas using the Retell AI Web SDK.

## How It Works

1. Agent selects a client persona from 8 available options
2. A voice call starts via Retell AI — the AI plays the client
3. The agent practices the 20-section sales call structure
4. If the agent skips sections or goes out of order, the persona hangs up
5. Post-call feedback explains what went wrong and which section to study
6. 2-minute cooldown before the next attempt

## Setup

### Prerequisites

- Node.js 18+
- [Retell AI](https://www.retellai.com/) API key

### Local Development

```bash
cp .env.example .env
# Edit .env and add your RETELL_API_KEY

npm install
npm start
```

Open http://localhost:3000

### Deploy on Railway

1. Push this repo to GitHub
2. Create a new project on [Railway](https://railway.app)
3. Connect your GitHub repo
4. Add the `RETELL_API_KEY` environment variable in Railway settings
5. Railway auto-detects the Dockerfile and deploys

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** Single-page HTML/CSS/JS (no build step)
- **Voice:** Retell AI Web SDK
- **Deployment:** Railway via Dockerfile

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RETELL_API_KEY` | Yes | — | Your Retell AI API key |
| `PORT` | No | 3000 | Server port (Railway sets this automatically) |

## API Endpoints

- `GET /api/personas` — List all personas
- `POST /api/create-call` — Create a voice call for a persona
- `GET /api/call/:callId` — Get call details and transcript
