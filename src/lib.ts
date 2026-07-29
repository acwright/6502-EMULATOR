// Execution layer — owns forward progress and pacing
export { Session } from './debug/Session'
export type { StopReason, StepKind } from './debug/Session'
export { Scheduler } from './debug/Scheduler'
export type { RunMode } from './debug/Scheduler'

// Debug core — breakpoints, disassembly, symbols
export { Breakpoints } from './debug/Breakpoints'
export type { Breakpoint, BreakpointSpec, BreakpointKind, BreakpointHit } from './debug/Breakpoints'
export { OPCODES, MODE_BYTES } from './debug/OpcodeTable'
export type { OpcodeInfo, AddrMode } from './debug/OpcodeTable'
export { disassemble, disassembleOne, disassembleRange, formatInstruction } from './debug/Disassembler'
export type { Instruction, ByteSource, SymbolResolver } from './debug/Disassembler'
export { compileExpression, evaluateExpression, ExpressionError } from './debug/Expression'
export type { EvalContext, CompiledExpression } from './debug/Expression'
export { SymbolTable } from './debug/symbols/Symbols'
export { parseViceLabels, parseCa65Dbg, parseSymbols, formatForPath } from './debug/symbols/parse'
export type { SymbolFormat } from './debug/symbols/parse'

// Debug service — JSON-RPC over WebSocket and HTTP
export { DebugServer } from './debug/server/DebugServer'
export type { DebugServerOptions, ListenResult } from './debug/server/DebugServer'
export { createMethods } from './debug/server/Methods'
export type { MethodTable, MethodHandler, MemorySpace } from './debug/server/Methods'
export type { DebugTarget } from './debug/server/DebugTarget'
export { ErrorCode, RpcMethodError, PROTOCOL_VERSION } from './debug/server/Protocol'
export type { RpcRequest, RpcResponse, RpcNotification, RpcError } from './debug/server/Protocol'
export { defaultLockPath, readLock, writeLock, clearLock } from './debug/server/LockFile'
export type { SessionLock } from './debug/server/LockFile'

// Core components
export { Machine } from './core/Machine'
export type { SlotConfig, SlotName } from './core/Machine'
export { CPU } from './core/CPU'
export { RAM } from './core/RAM'
export { ROM } from './core/ROM'
export { Cart } from './core/Cart'
export type { IO } from './core/IO'

// IO cards
export { Empty } from './core/IO/Empty'
export { VIA } from './core/IO/VIA'
export { RAMBank } from './core/IO/RAMBank'
export { RTC } from './core/IO/RTC'
export { ACIA } from './core/IO/ACIA'
export { SIDVoice, Sound } from './core/IO/Sound'
export { Storage } from './core/IO/Storage'
export { Video } from './core/IO/Video'

// GPIO attachments
export type { Attachment } from './core/IO/Attachments/Attachment'
export { AttachmentBase } from './core/IO/Attachments/Attachment'
export { JoystickAttachment } from './core/IO/Attachments/JoystickAttachment'
export { KeyboardEncoderAttachment } from './core/IO/Attachments/KeyboardEncoderAttachment'
export { KeyboardMatrixAttachment } from './core/IO/Attachments/KeyboardMatrixAttachment'
