import assert from "node:assert/strict";

/**
 * Requires a mapping rather than treating an array as a YAML object.
 *
 * @param value - Parsed value whose mapping shape must be verified.
 * @returns A mapping with values that still require narrowing.
 * @throws An assertion error when the value is not a mapping.
 */
export function record(value: unknown): Record<string, unknown> {
	assert.ok(
		typeof value === "object" && value !== null && !Array.isArray(value),
	);
	return value as Record<string, unknown>;
}

/**
 * Requires a sequence rather than assuming a parsed YAML value is iterable.
 *
 * @param value - Parsed value whose sequence shape must be verified.
 * @returns A sequence with elements that still require narrowing.
 * @throws An assertion error when the value is not an array.
 */
export function array(value: unknown): unknown[] {
	assert.ok(Array.isArray(value));
	return value;
}

/**
 * Matches stable error codes instead of relying on potentially sensitive messages.
 *
 * @param error - Caught value to inspect.
 * @param code - Expected stable error code.
 * @returns Whether the error exposes the expected code.
 */
export function errorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
