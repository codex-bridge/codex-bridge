import { GrammyError } from "grammy";

export function isTelegramRichMessageRejection(error: unknown): error is GrammyError {
  return error instanceof GrammyError && error.error_code === 400 &&
    /can't parse (?:rich message|entities)|unsupported (?:start tag|end tag|tag)|can't find end (?:tag|of the entity)/i.test(error.description);
}
