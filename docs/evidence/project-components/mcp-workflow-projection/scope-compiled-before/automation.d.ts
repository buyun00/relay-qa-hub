import type { FastifyInstance } from "fastify";
type Values = Record<string, unknown>;
interface ToolDefinition {
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly inputSchema: Values;
    readonly annotations: Values;
}
export declare const AUTOMATION_TOOLS: readonly ToolDefinition[];
/** Protocol adaptation only: all operations enter the authenticated HTTP business handlers. */
export declare function registerAutomationRoutes(app: FastifyInstance, publicApiOrigin: string, allowedOrigins?: readonly string[]): void;
export {};
//# sourceMappingURL=automation.d.ts.map