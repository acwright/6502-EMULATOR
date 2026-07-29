/**
 * JSON-RPC 2.0 types and the error vocabulary the debug service speaks.
 *
 * JSON-RPC rather than a bespoke protocol for one reason that matters here: it
 * is the same shape as the Debug Adapter Protocol and the Language Server
 * Protocol, so a VSCode extension, an MCP server or a GUI debugger written
 * later are all transport-compatible with what a shell script already does.
 */

export const PROTOCOL_VERSION = 1

export interface RpcRequest {
  jsonrpc: '2.0'
  /** Absent for a notification the client does not want answered. */
  id?: string | number | null
  method: string
  params?: unknown
}

export interface RpcError {
  code: number
  message: string
  data?: unknown
}

export interface RpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: RpcError
}

export interface RpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

/**
 * Error codes.
 *
 * -32768..-32000 is reserved by the spec; the pre-defined ones keep their
 * standard meanings and the application codes sit at the top of the reserved
 * application range, where the spec says implementations may define their own.
 */
export const ErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  /** The method exists but this host cannot serve it — no serial card, say. */
  NOT_SUPPORTED: -32000,
  /** Loading a ROM, cart, program or symbol file failed. */
  LOAD_FAILED: -32001,
  /** The token was missing or wrong. */
  UNAUTHORIZED: -32002,
  /** A request that could not be honoured in the machine's current state. */
  INVALID_STATE: -32003
} as const

/** An error a method handler raises to control the code the client sees. */
export class RpcMethodError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'RpcMethodError'
  }
}

export const invalidParams = (message: string): RpcMethodError =>
  new RpcMethodError(ErrorCode.INVALID_PARAMS, message)

export const notSupported = (message: string): RpcMethodError =>
  new RpcMethodError(ErrorCode.NOT_SUPPORTED, message)

export function isRequest(value: unknown): value is RpcRequest {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return candidate.jsonrpc === '2.0' && typeof candidate.method === 'string'
}

export const response = (id: string | number | null, result: unknown): RpcResponse => ({
  jsonrpc: '2.0',
  id,
  result
})

export const errorResponse = (
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): RpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) }
})

export const notification = (method: string, params?: unknown): RpcNotification => ({
  jsonrpc: '2.0',
  method,
  ...(params === undefined ? {} : { params })
})
