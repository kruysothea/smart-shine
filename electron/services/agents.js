const { exec } = require('child_process');
const { promisify } = require('util');
const execp = promisify(exec);

const AGENT_PATTERNS = [
  { re: /claude(\s|$|-code|\.app)/i, name: 'Claude Code', vendor: 'Anthropic' },
  { re: /anthropic/i, name: 'Anthropic CLI', vendor: 'Anthropic' },
  { re: /\bcodex\b/i, name: 'Codex', vendor: 'OpenAI' },
  { re: /\bgpt\b|chatgpt/i, name: 'ChatGPT', vendor: 'OpenAI' },
  { re: /openai/i, name: 'OpenAI', vendor: 'OpenAI' },
  { re: /cursor-agent|cursor\.app/i, name: 'Cursor', vendor: 'Cursor' },
  { re: /windsurf/i, name: 'Windsurf', vendor: 'Codeium' },
  { re: /copilot/i, name: 'GitHub Copilot', vendor: 'GitHub' },
  { re: /gemini/i, name: 'Gemini', vendor: 'Google' },
  { re: /ollama/i, name: 'Ollama', vendor: 'Ollama' },
  { re: /lm[\s-]?studio/i, name: 'LM Studio', vendor: 'LM Studio' },
  { re: /llama\.cpp|llama-server|llamafile/i, name: 'llama.cpp', vendor: 'ggerganov' },
  { re: /jan\.app/i, name: 'Jan', vendor: 'Jan' },
  { re: /perplexity/i, name: 'Perplexity', vendor: 'Perplexity' },
  { re: /aider/i, name: 'Aider', vendor: 'Aider' },
  { re: /continue\.app|continue-cli/i, name: 'Continue', vendor: 'Continue' },
];

function classify(cmd) {
  for (const p of AGENT_PATTERNS) if (p.re.test(cmd)) return p;
  return null;
}

async function list() {
  // ps with cpu%, mem%, rss, pid, command
  const { stdout } = await execp('ps -axwwo pid=,pcpu=,pmem=,rss=,etime=,command=', { maxBuffer: 8 * 1024 * 1024 });
  const lines = stdout.split('\n').filter(Boolean);
  const results = [];
  const seen = new Set();
  for (const line of lines) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const [, pid, cpu, mem, rss, etime, command] = m;
    const cls = classify(command);
    if (!cls) continue;
    if (seen.has(pid)) continue;
    seen.add(pid);
    results.push({
      pid: Number(pid),
      cpu: Number(cpu),
      mem: Number(mem),
      rssBytes: Number(rss) * 1024,
      etime,
      command: command.length > 220 ? command.slice(0, 220) + '…' : command,
      name: cls.name,
      vendor: cls.vendor,
    });
  }
  return results.sort((a, b) => b.cpu - a.cpu);
}

async function kill(pid) {
  // Reject non-positive / non-integer pids: pid<=1 could signal a process group
  // (negative) or launchd (1), letting a caller kill far more than one process.
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, error: 'Invalid pid' };
  try {
    process.kill(pid, 'SIGTERM');
    setTimeout(() => {
      try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch (_) {}
    }, 1500);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { list, kill };
