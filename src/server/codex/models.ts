import { z } from "zod";

export const SupportedModelSchema = z.enum(["gpt-6-sol", "gpt-6-luna"]);
