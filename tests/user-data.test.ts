import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { isolateUserDataEnvironment } from '../src/main/user-data'

test('userData isolation redirects the home and Pi config roots into the sandbox', () => {
  const env: NodeJS.ProcessEnv = {
    HOME: 'C:/Users/real',
    USERPROFILE: 'C:/Users/real',
    PI_CODING_AGENT_DIR: 'C:/Users/real/.pi/agent',
    PI_CODING_AGENT_SESSION_DIR: 'C:/Users/real/.pi/agent/sessions'
  }
  const userData = path.resolve('isolated-user-data')
  const home = path.join(userData, 'home')
  const agent = path.join(home, '.pi', 'agent')

  isolateUserDataEnvironment(userData, env)

  assert.equal(env.HOME, home)
  assert.equal(env.USERPROFILE, home)
  assert.equal(env.PI_CODING_AGENT_DIR, agent)
  assert.equal(env.PI_CODING_AGENT_SESSION_DIR, path.join(agent, 'sessions'))
})
