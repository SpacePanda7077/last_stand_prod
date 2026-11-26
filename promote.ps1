# Run from the repo root in PowerShell.
# Makes the Phaser game in game\ the root project.
$ErrorActionPreference = 'Stop'

# 1. remove the Coinflip template frontend (contracts\ and deployment.ts stay)
git rm -rq src index.html vite.config.ts tsconfig.json package.json package-lock.json

# 2. promote the Phaser project to root (public\game.manifest.json stays)
git mv game/src src
git mv game/index.html index.html
git mv game/vite vite
git mv game/tsconfig.json tsconfig.json
git mv game/tsconfig.node.json tsconfig.node.json
git mv game/package.json package.json
git mv game/package-lock.json package-lock.json
git mv game/public/assets public/assets
git mv game/public/favicon.png public/favicon.png
git mv game/public/style.css public/style.css

# 3. drop the rest of game\ (license, README, telemetry log.js, screenshot)
git rm -rfq game 2>$null
if (Test-Path game) { Remove-Item -Recurse -Force game }

# 4. scripts: plain vite dev (no telemetry ping), prod build, simulator
@'
const fs = require("fs");
const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
p.name = "last-stand";
p.scripts = {
  dev: "vite --config vite/config.dev.mjs",
  build: "vite build --config vite/config.prod.mjs",
  preview: "vite preview --config vite/config.dev.mjs",
  simulator: "chain dev casino --frontend-url http://localhost:3100"
};
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
'@ | Set-Content -Encoding ascii fix-package.cjs
node fix-package.cjs
Remove-Item fix-package.cjs

npm install
Write-Host "Done. Now: npm run dev   (and in a 2nd terminal: npm run simulator)"
