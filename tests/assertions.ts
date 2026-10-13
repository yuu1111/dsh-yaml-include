import assert from "node:assert/strict";

export function record(value: unknown): Record<string, unknown> {
	assert.ok(
		typeof value === "object" && value !== null && !Array.isArray(value),
	);
	return value as Record<string, unknown>;
}

export function array(value: unknown): unknown[] {
	assert.ok(Array.isArray(value));
	return value;
}

export function errorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
