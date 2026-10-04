// Loaded before every test file. The jest-dom matchers (toBeInTheDocument, toHaveTextContent)
// are only meaningful in the UI tests, which run under jsdom; registering them here keeps every
// test file free of setup code.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})
