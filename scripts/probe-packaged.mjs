import { spawn } from 'node:child_process'

const exe = 'E:\\Program\\Pi Desktop\\release\\win-unpacked\\Pi Desktop.exe'
const cli =
  'E:\\Program\\Pi Desktop\\release\\win-unpacked\\resources\\app.asar.unpacked\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js'

const args = process.argv.slice(2)
const child = spawn(exe, [cli, ...args], {
  cwd: 'C:\\Users\\Facron\\AppData\\Local\\Temp\\pi-desktop-demo',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'pipe']
})

child.stdout.on('data', (chunk) => console.log('OUT:', chunk.toString('utf8').slice(0, 400)))
child.stderr.on('data', (chunk) => console.log('ERR:', chunk.toString('utf8').slice(0, 2000)))
child.on('exit', (code, signal) => console.log('EXIT', code, signal))

setTimeout(() => {
  child.stdin.write(JSON.stringify({ id: 'a', type: 'get_state' }) + '\n')
}, 2500)
setTimeout(() => child.kill(), 7000)
