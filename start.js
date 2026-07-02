const { spawn } = require('child_process');
const path = require('path');

const server = spawn('node', ['server.js'], {
  cwd: __dirname,
  stdio: ['ignore', 'pipe', 'pipe']
});

server.stdout.on('data', d => process.stdout.write(d));
server.stderr.on('data', d => process.stderr.write(d));

const cf = spawn(path.join(__dirname, 'cloudflared.exe'), ['tunnel', '--url', 'http://localhost:3001'], {
  stdio: ['ignore', 'pipe', 'pipe']
});

let buf = '';
cf.stderr.on('data', d => {
  buf += d.toString();
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (line.includes('trycloudflare.com')) {
      const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        console.log('\n=== TUNNEL URL ===');
        console.log(m[0]);
        console.log('Webhook URL: ' + m[0] + '/api/webhook');
        console.log('==================\n');
      }
    }
  }
});

process.on('SIGINT', () => { server.kill(); cf.kill(); process.exit(); });
process.on('SIGTERM', () => { server.kill(); cf.kill(); process.exit(); });
