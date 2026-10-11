import { GrammyError } from "grammy";

export function isTelegramRichMessageRejection(error: unknown): error is GrammyError {
  return error instanceof GrammyError && error.error_code === 400;
}
