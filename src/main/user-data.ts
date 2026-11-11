import path from 'node:path'

/** Keep a harness userData override from falling through to the real home. */
export function isolateUserDataEnvironment(
  userData: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  const home = path.join(path.resolve(userData), 'home')
  const agent = path.join(home, '.pi', 'agent')
  env.HOME = home
  env.USERPROFILE = home
  env.PI_CODING_AGENT_DIR = agent
  env.PI_CODING_AGENT_SESSION_DIR = path.join(agent, 'sessions')
}
