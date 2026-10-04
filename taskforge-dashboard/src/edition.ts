// Which edition this build is. The browser edition (VITE_DEMO=1) drives the simulator in src/sim
// and never calls the API; the service edition is the page the API jar serves at "/".
export const IS_BROWSER_EDITION = import.meta.env.VITE_DEMO === '1'

export const EDITION: 'browser' | 'service' = IS_BROWSER_EDITION ? 'browser' : 'service'

export const REPO_URL = 'https://github.com/carlous-roy/TaskForge-Engine'
