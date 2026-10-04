import { IS_BROWSER_EDITION } from './edition.ts'
import ConsolePage from './pages/ConsolePage.tsx'
import ServicePage from './pages/ServicePage.tsx'

export default function App() {
  return IS_BROWSER_EDITION ? <ConsolePage /> : <ServicePage />
}
