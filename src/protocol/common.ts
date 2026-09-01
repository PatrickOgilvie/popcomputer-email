import { Schema } from "effect"
import {
  MaximumPageSize,
  MessageIdSchema,
  PageCursorSchema,
  RouteIdSchema,
  TestRecipientIdSchema,
  WorkflowIdSchema,
} from "../core/identifiers.js"
import { EnvironmentSchema } from "../core/scope.js"
import { ReceivedAttachmentIdSchema } from "../core/received-content.js"

/** Maximum page size accepted by hosted list operations. */
export { MaximumPageSize } from "../core/identifiers.js"

/** Optional list cursor and bounded result count used by hosted operations. */
export const PageQuerySchema = Schema.Struct({
  cursor: Schema.optionalKey(PageCursorSchema),
  limit: Schema.optionalKey(
    Schema.NumberFromString.pipe(
      Schema.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 1, maximum: MaximumPageSize }),
      ),
    ),
  ),
})

/** Environment returned for a resource scoped by the bearer credential. */
export const ResourceEnvironmentSchema = EnvironmentSchema

/** Path parameters for one hosted message resource. */
export const MessagePathSchema = Schema.Struct({ email: MessageIdSchema })

/** Path parameters for one hosted received-attachment resource. */
export const ReceivedAttachmentPathSchema = Schema.Struct({
  email: MessageIdSchema,
  attachment: ReceivedAttachmentIdSchema,
})

/** Path parameters for one hosted route resource. */
export const RoutePathSchema = Schema.Struct({ route: RouteIdSchema })

/** Path parameters for one hosted test-recipient resource. */
export const TestRecipientPathSchema = Schema.Struct({
  recipient: TestRecipientIdSchema,
})

/** Opaque workflow identity accepted by workflow-trigger route commands. */
export const ProtocolWorkflowIdSchema = WorkflowIdSchema
