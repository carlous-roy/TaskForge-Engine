// The simulator's public surface: the Simulation the console drives, its configuration and the
// shapes it returns, and the helpers a page needs to print times and durations the way the
// services print them.

export * from './types.ts'
export { DEFAULT_CONFIG } from './config.ts'
export { Simulation } from './simulation.ts'
export type { FaultKind } from './faults.ts'
export { SIM_EPOCH_MS, formatDuration, formatInstant } from './java.ts'
export { allowedNames, validate as validateParameters } from './parameters.ts'
export { isValidCorrelationId } from './api.ts'
export { LOG_LIMIT } from './log.ts'
export { HISTORY_LIMIT } from './world.ts'
