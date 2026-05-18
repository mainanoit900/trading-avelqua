const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const CONFIG = {
  apiBase: "https://trading.avelqua.com/admin/api/agent",
  token: "7da887c8b5fa20f3e0c350cf18496b3b89540b32a4d225589bf2584bbb496728",
  intervalMs: 5000,
  autoHealthMs: 30000,
  ports: ["PORT01", "PORT02", "PORT03", "PORT04", "PORT05", "PORT06"],
  logFile: "C:\\avelqua-agent\\agent.log",
  updateUrl: "https://trading.avelqua.com/downloads/agent.js",
  agentFile: "C:\\avelqua-agent\\agent.js",
  newAgentFile: "C:\\avelqua-agent\\agent_new.js"
};

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(line.trim());
  fs.appendFileSync(CONFIG.logFile, line);
}

function execCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout || "",
        stderr: stderr || "",
        error: error ? error.message : null
      });
    });
  });
}

async function apiGet(pathUrl) {
  const res = await fetch(CONFIG.apiBase + pathUrl, {
    headers: { "x-agent-token": CONFIG.token }
  });
  return res.json();
}

async function apiPost(pathUrl, body = {}) {
  const res = await fetch(CONFIG.apiBase + pathUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-agent-token": CONFIG.token
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

function getMt5Path(port) {
  return `C:\\MT5_PORTS\\${port}\\terminal64.exe`;
}

async function runCommand(command, payload = {}) {
  const port = payload.port || "PORT01";
  const MT5_PATH = getMt5Path(port);

  if (command === "health_check") {
    const result = await execCmd(`tasklist /FI "IMAGENAME eq terminal64.exe" | findstr terminal64.exe`);
    return { ...result, command, port, mt5Path: MT5_PATH };
  }

  if (command === "start_mt5") {
    const result = await execCmd(`start "" "${MT5_PATH}"`);
    return { ...result, command, port, mt5Path: MT5_PATH };
  }

  if (command === "restart_mt5") {
    const result = await execCmd(`taskkill /IM terminal64.exe /F & timeout /t 3 & start "" "${MT5_PATH}"`);
    return { ...result, command, port, mt5Path: MT5_PATH };
  }

  if (command === "run_bot") {
    const result = await execCmd(`echo run_bot ready ${port}`);
    return { ...result, command, port, mt5Path: MT5_PATH };
  }

  if (command === "stop_bot") {
    const result = await execCmd(`echo stop_bot ready ${port}`);
    return { ...result, command, port, mt5Path: MT5_PATH };
  }

  if (command === "sync_mt5") {
    const result = await execCmd(`echo sync_mt5 ready ${port}`);
    return { ...result, command, port, mt5Path: MT5_PATH };
  }

  if (command === "restart_agent") {
    log("Restart agent requested");
    setTimeout(() => process.exit(0), 1000);
    return { ok: true, command, message: "agent restarting" };
  }

  if (command === "update_agent") {
    log("Update agent requested");

    const downloadCmd =
  `powershell -ExecutionPolicy Bypass -Command "& {Invoke-WebRequest -Uri \\"${CONFIG.updateUrl}\\" -OutFile \\"${CONFIG.newAgentFile}\\"}"`;

    const download = await execCmd(downloadCmd);

    if (!download.ok) {
      return { ok: false, command, step: "download", ...download };
    }

    fs.copyFileSync(CONFIG.newAgentFile, CONFIG.agentFile);

    log("Agent updated. Restarting...");
    setTimeout(() => process.exit(0), 1000);

    return { ok: true, command, message: "agent updated and restarting" };
  }

  return { ok: false, command, port, message: "unknown command: " + command };
}

async function commandLoop() {
  try {
    const data = await apiGet("/commands");

    if (!data.ok) {
      log("API error: " + JSON.stringify(data));
      return;
    }

    for (const item of data.commands || []) {
      const command = item.command || item.command_type;
      const payload = item.payload || item.command_payload || {};

      log(`Run command #${item.id}: ${command} ${JSON.stringify(payload)}`);

      const result = await runCommand(command, payload);

      log(`Result #${item.id}: ${JSON.stringify(result)}`);

      await apiPost(`/commands/${item.id}/done`, result);
    }
  } catch (err) {
    log("ERROR commandLoop: " + err.message);
  }
}

async function autoHealthLoop() {
  for (const port of CONFIG.ports) {
    try {
      const result = await runCommand("health_check", { port });

      if (!result.ok) {
        log(`MT5 offline on ${port}. Auto restart...`);
        await runCommand("restart_mt5", { port });
      }
    } catch (err) {
      log(`ERROR autoHealth ${port}: ${err.message}`);
    }
  }
}

log("Avelqua Windows Agent started");

setInterval(commandLoop, CONFIG.intervalMs);
setInterval(autoHealthLoop, CONFIG.autoHealthMs);

commandLoop();
autoHealthLoop();