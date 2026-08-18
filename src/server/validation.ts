import type { FastifyReply } from "fastify";
import type { ZodType } from "zod";

export function parseBody<T>(schema: ZodType<T>, value: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  void reply.code(400).send({
    error: "VALIDATION_ERROR",
    message: "请求参数不正确",
    details: result.error.flatten(),
  });
  return null;
}
