import { z } from "zod";
import { ActionType, LogicalOperator } from "@/generated/prisma/enums";
import { isMicrosoftProvider } from "@/utils/email/provider-types";
import { isDefined } from "@/utils/types";
import {
  getAvailableActionsForRuleEditor,
  getExtraAvailableActionsForRuleEditor,
} from "@/utils/ai/rule/action-availability";
import { delayInMinutesLlmSchema } from "@/utils/actions/rule.validation";
import {
  AI_INSTRUCTIONS_PROMPT_DESCRIPTION,
  INVALID_STATIC_FROM_MESSAGE,
  isInvalidStaticFromValue,
  STATIC_FROM_CONDITION_DESCRIPTION,
} from "@/utils/ai/rule/rule-condition-descriptions";

const conditionSchema = z
  .object({
    conditionalOperator: z
      .enum([LogicalOperator.AND, LogicalOperator.OR])
      .nullable()
      .describe(
        "The conditional operator to use. AND means all conditions must be true for the rule to match. OR means any condition can be true for the rule to match. This does not impact sub-conditions.",
      ),
    aiInstructions: z
      .string()
      .nullish()
      .transform((v) => (v?.trim() ? v : null))
      .describe(AI_INSTRUCTIONS_PROMPT_DESCRIPTION),
    static: z
      .object({
        from: z
          .string()
          .nullish()
          .transform((v) => (v?.trim() ? v : null))
          .refine((value) => !isInvalidStaticFromValue(value), {
            message: INVALID_STATIC_FROM_MESSAGE,
          })
          .describe(STATIC_FROM_CONDITION_DESCRIPTION),
        to: z.string().nullish().describe("The to email address to match"),
        subject: z.string().nullish().describe("The subject to match"),
      })
      .nullish()
      .describe(
        "The static conditions to match. If multiple static conditions are specified, the rule will match if ALL of the conditions match (AND operation)",
      ),
  })
  .describe("The conditions to match");

export function getAvailableActions(provider: string) {
  const availableActions = getAvailableActionsForRuleEditor({
    provider,
  }).filter(isDefined);
  return availableActions as [ActionType, ...ActionType[]];
}

export const getExtraActions = (existingActionTypes: ActionType[] = []) =>
  getExtraAvailableActionsForRuleEditor(existingActionTypes);

export type RuleActionFields = {
  label?: string | null;
  to?: string | null;
  cc?: string | null;
  bcc?: string | null;
  subject?: string | null;
  content?: string | null;
  webhookUrl?: string | null;
  folderName?: string | null;
};

export type RuleAction = {
  type: ActionType;
  fields?: RuleActionFields | null;
  delayInMinutes?: number | null;
};

// NOTE: This schema is intentionally a single flat object (not a z.union or
// z.discriminatedUnion of per-type variants). Anthropic's tool/structured-output
// schemas have a hard limit of 24 optional parameters per schema, and unioning
// ~11 action variants -- each carrying ~8 nullish field properties -- caused
// "Prompt to rules" to fail with "Schemas contains too many optional parameters
// (87), which would make grammar compilation inefficient. ... limit: 24"
// (issue #2323). Collapsing to a single shape with all fields nullish keeps the
// optional count well under the limit; per-type required fields are enforced
// in superRefine() below so runtime semantics are preserved.
export const createRuleActionSchema = (
  provider: string,
): z.ZodType<RuleAction> => {
  const allowedActionTypes = Array.from(
    new Set([
      ...getAvailableActionsForRuleEditor({ provider }),
      ...getExtraAvailableActionsForRuleEditor(),
    ]),
  ) as ActionType[];

  if (allowedActionTypes.length === 0) {
    throw new Error("No rule actions are available for this provider.");
  }

  const typeEnum = z.enum(
    allowedActionTypes as [ActionType, ...ActionType[]],
  );

  const fieldsSchema = z
    .object(createActionFieldShape(provider))
    .nullish()
    .transform((value) => value ?? null);

  const actionTypeDescription = `The action to apply to the matching email. Allowed values: ${allowedActionTypes.join(", ")}. ${getCombinedActionTypeDescriptions(allowedActionTypes)}`;

  const baseSchema = z.object({
    type: typeEnum.describe(actionTypeDescription),
    fields: fieldsSchema,
    delayInMinutes: delayInMinutesLlmSchema,
  });

  const requireField = (
    action: z.infer<typeof baseSchema>,
    key: keyof RuleActionFields,
    message: string,
    ctx: z.RefinementCtx,
  ) => {
    const value = action.fields?.[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message,
        path: ["fields", key],
      });
    }
  };

  return baseSchema.superRefine((action, ctx) => {
    switch (action.type) {
      case ActionType.LABEL:
        requireField(action, "label", "LABEL requires fields.label.", ctx);
        break;
      case ActionType.SEND_EMAIL:
        requireField(
          action,
          "to",
          "SEND_EMAIL requires fields.to.",
          ctx,
        );
        break;
      case ActionType.FORWARD:
        requireField(action, "to", "FORWARD requires fields.to.", ctx);
        break;
      case ActionType.CALL_WEBHOOK:
        requireField(
          action,
          "webhookUrl",
          "CALL_WEBHOOK requires fields.webhookUrl.",
          ctx,
        );
        break;
      case ActionType.MOVE_FOLDER:
        if (!isMicrosoftProvider(provider)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "MOVE_FOLDER is only supported for Microsoft providers.",
            path: ["type"],
          });
        } else {
          requireField(
            action,
            "folderName",
            "MOVE_FOLDER requires fields.folderName.",
            ctx,
          );
        }
        break;
      default:
        break;
    }
  }) as unknown as z.ZodType<RuleAction>;
};

export const createRuleSchema = (provider: string) =>
  z.object({
    name: z
      .string()
      .describe(
        "A short, concise name for the rule (preferably a single word). For example: 'Marketing', 'Newsletters', 'Urgent', 'Receipts'. Avoid verbose names like 'Archive and label marketing emails'.",
      ),
    condition: conditionSchema,
    actions: z
      .array(createRuleActionSchema(provider))
      .describe("The actions to take"),
  });

export type CreateRuleSchema = z.infer<ReturnType<typeof createRuleSchema>>;
export type CreateOrUpdateRuleSchema = CreateRuleSchema & {
  ruleId?: string;
};

function getActionTypeDescription(type: ActionType) {
  switch (type) {
    case ActionType.DRAFT_EMAIL:
      return "Draft a reply to the matching inbound email without sending it. Use this for draft reply requests.";
    case ActionType.REPLY:
      return "Send a reply to the matching inbound email. Do not use this for draft reply requests.";
    case ActionType.SEND_EMAIL:
      return "Send a new outbound email. Do not use this for draft reply requests.";
    case ActionType.FORWARD:
      return "Forward the matching email.";
    case ActionType.LABEL:
      return "Apply a label to the matching email.";
    case ActionType.ARCHIVE:
      return "Archive the matching email.";
    case ActionType.MARK_READ:
      return "Mark the matching email as read.";
    case ActionType.STAR:
      return "Star the matching email.";
    case ActionType.MARK_SPAM:
      return "Mark the matching email as spam.";
    case ActionType.DIGEST:
      return "Include the matching email in a digest.";
    case ActionType.CALL_WEBHOOK:
      return "Call a webhook for the matching email.";
    case ActionType.MOVE_FOLDER:
      return "Move the matching email to a folder.";
    default:
      return "Action type to apply to the matching email.";
  }
}

function getCombinedActionTypeDescriptions(types: ActionType[]): string {
  return types
    .map((type) => `${type}: ${getActionTypeDescription(type)}`)
    .join(" ");
}

function createActionFieldShape(provider: string) {
  return {
    label: optionalStringField(
      "The label to apply to the email. Required when type=LABEL.",
    ),
    to: optionalStringField(
      "The recipient email address. Required when type=SEND_EMAIL or type=FORWARD. Use REPLY when responding to the triggering inbound email.",
    ),
    cc: optionalStringField("The cc email address to send the email to"),
    bcc: optionalStringField("The bcc email address to send the email to"),
    subject: optionalStringField("The subject of the email"),
    content: optionalStringField("The content of the email"),
    webhookUrl: optionalStringField(
      "The webhook URL to call. Required when type=CALL_WEBHOOK.",
    ),
    ...(isMicrosoftProvider(provider) && {
      folderName: optionalStringField(
        "The folder to move the email to. Required when type=MOVE_FOLDER.",
      ),
    }),
  };
}

function optionalStringField(description: string) {
  return z
    .string()
    .nullish()
    .transform((value) => value ?? null)
    .describe(description);
}
