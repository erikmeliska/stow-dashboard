import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const transport = new StdioClientTransport({ command: 'node', args: [path.join(__dirname, 'server.mjs')] })
const client = new Client({ name: 'smoke', version: '0.0.0' }, { capabilities: {} })
await client.connect(transport)
const { tools } = await client.listTools()
const names = tools.map(t => t.name)
const required = ['get_status', 'set_status', 'list_scripts', 'run_script']
const missing = required.filter(n => !names.includes(n))
await client.close()
if (missing.length) { console.error('MISSING TOOLS:', missing); process.exit(1) }
console.log('OK: new MCP tools present:', required.join(', '))
process.exit(0)
