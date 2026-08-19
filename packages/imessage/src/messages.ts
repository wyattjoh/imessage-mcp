import { Database } from "@db/sqlite";
import type {
  Chat,
  Handle,
  MessageWithHandle,
  PaginatedResult,
  SearchOptions,
} from "./types.ts";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Converts an Apple timestamp (nanoseconds since 2001-01-01) to a JavaScript timestamp
 * @param appleTimestamp - Timestamp in Apple's format (nanoseconds since 2001-01-01)
 * @returns JavaScript timestamp (milliseconds since 1970-01-01)
 */
export const convertAppleTimestamp = (appleTimestamp: number): number => {
  // 978307200 is the number of seconds between 1970-01-01 and 2001-01-01
  return appleTimestamp / 1000000000 + 978307200;
};

/**
 * Decodes NSAttributedString data from the attributedBody field.
 * Uses pattern matching approach to extract plain text from binary NSAttributedString format.
 * @param attributedBodyBlob - Binary data containing NSAttributedString
 * @returns Extracted plain text string
 */
export const decodeAttributedBody = (
  attributedBodyBlob: Uint8Array | null,
): string => {
  if (!attributedBodyBlob) return "";

  try {
    // Decode binary data to UTF-8 string
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let attributedBody = decoder.decode(attributedBodyBlob);

    // Apply pattern matching similar to Python implementation
    if (attributedBody.includes("NSNumber")) {
      attributedBody = attributedBody.split("NSNumber")[0];
    }
    if (attributedBody.includes("NSString")) {
      attributedBody = attributedBody.split("NSString")[1];
    }
    if (attributedBody.includes("NSDictionary")) {
      attributedBody = attributedBody.split("NSDictionary")[0];
    }

    // Trim wrapper characters (first 6, last 12)
    if (attributedBody.length > 18) {
      attributedBody = attributedBody.slice(6, -12);
    }

    // Clean up whitespace and non-printable characters
    return (
      attributedBody
        // deno-lint-ignore no-control-regex
        .replace(/[\x00-\x1F\x7F-\x9F]/g, "") // Remove control characters
        .replace(/\s+/g, " ") // Normalize whitespace
        .trim()
    );
  } catch (error) {
    console.warn("Failed to decode attributedBody:", error);
    return "";
  }
};

const getImessageDbPath = (): string => {
  return join(homedir(), "Library", "Messages", "chat.db");
};

/**
 * Opens a read-only connection to the macOS Messages database.
 * @returns Database instance for executing queries
 */
export const openMessagesDatabase = (): Database => {
  const dbPath = getImessageDbPath();
  return new Database(dbPath, { readonly: true });
};

const createPaginationMetadata = (
  total: number,
  limit: number,
  offset: number,
) => {
  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);
  const hasMore = offset + limit < total;

  return {
    total,
    limit,
    offset,
    hasMore,
    page,
    totalPages,
  };
};

/**
 * Searches for messages with optional filtering by query text, contact handle, and date range.
 * @param messagesDatabase - Database connection to use
 * @param options - Search and filter options
 * @returns Paginated results with message data and metadata
 */
export const searchMessages = (
  messagesDatabase: Database,
  options: SearchOptions = {},
): PaginatedResult<MessageWithHandle> => {
  const {
    query,
    handle,
    startDate,
    endDate,
    limit = 100,
    offset = 0,
  } = options;

  let whereClause = "WHERE 1=1";
  const params: (string | number)[] = [];

  // When a text query is provided, include rows where m.text matches OR
  // m.text is NULL (content may live in attributedBody on modern macOS).
  // Actual keyword filtering for attributedBody rows happens post-decode.
  if (query) {
    whereClause += " AND (m.text LIKE ? OR m.text IS NULL)";
    params.push(`%${query}%`);
  }

  if (handle) {
    whereClause += " AND h.id = ?";
    params.push(handle);
  }

  if (startDate) {
    const appleTimestamp = startDate.getTime() / 1000 - 978307200;
    whereClause += " AND m.date >= ?";
    params.push(appleTimestamp * 1000000000);
  }

  if (endDate) {
    const appleTimestamp = endDate.getTime() / 1000 - 978307200;
    whereClause += " AND m.date <= ?";
    params.push(appleTimestamp * 1000000000);
  }

  // When a text query is present we over-fetch from the DB because some
  // attributedBody rows will not match after decoding. We paginate in
  // application code instead so counts stay accurate.
  const needsPostFilter = !!query;

  // Get paginated data -- when post-filtering, fetch without LIMIT/OFFSET
  // so we can filter, then slice for the requested page.
  const dataSql = `
    SELECT
      m.guid,
      m.text,
      m.attributedBody,
      m.handle_id,
      m.service,
      m.date/1000000000 + 978307200 as date,
      m.date_read/1000000000 + 978307200 as date_read,
      m.date_delivered/1000000000 + 978307200 as date_delivered,
      m.is_from_me,
      m.is_read,
      m.is_sent,
      m.is_delivered,
      m.cache_has_attachments,
      m.thread_originator_guid as reply_to_guid,
      h.id as handle_id_string,
      h.country as handle_country,
      h.service as handle_service
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    ${whereClause}
    ORDER BY m.date DESC${needsPostFilter ? "" : " LIMIT ? OFFSET ?"}
  `;

  const dataStmt = messagesDatabase.prepare(dataSql);
  interface RawMessageRow extends MessageWithHandle {
    attributedBody?: Uint8Array | null;
  }
  const rawData = (
    needsPostFilter
      ? dataStmt.all(...params)
      : dataStmt.all(...params, limit, offset)
  ) as RawMessageRow[];

  // Decode attributedBody, then apply text filter in application code
  const queryLower = query?.toLowerCase();

  const allMatching = rawData.reduce<MessageWithHandle[]>((acc, row) => {
    const { attributedBody, ...message } = row;

    if (!message.text && attributedBody) {
      message.text = decodeAttributedBody(attributedBody);
    }

    if (needsPostFilter && queryLower) {
      const text = message.text?.toLowerCase() ?? "";
      if (!text.includes(queryLower)) return acc;
    }

    acc.push(message);
    return acc;
  }, []);

  const total = needsPostFilter ? allMatching.length : (() => {
    const countSql = `
      SELECT COUNT(*) as total
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      ${whereClause}
    `;
    const countStmt = messagesDatabase.prepare(countSql);
    return (countStmt.get(...params) as { total: number }).total;
  })();

  const data = needsPostFilter
    ? allMatching.slice(offset, offset + limit)
    : allMatching;

  return {
    data,
    pagination: createPaginationMetadata(total, limit, offset),
  };
};

/**
 * Gets the most recent messages across all conversations.
 * @param messagesDatabase - Database connection to use
 * @param limit - Maximum number of messages to return (default: 20)
 * @param offset - Number of messages to skip for pagination (default: 0)
 * @returns Paginated results with recent messages ordered by date
 */
export const getRecentMessages = (
  messagesDatabase: Database,
  limit = 20,
  offset = 0,
): PaginatedResult<MessageWithHandle> => {
  return searchMessages(messagesDatabase, { limit, offset });
};

/**
 * Gets all chat conversations ordered by most recent activity.
 * @param messagesDatabase - Database connection to use
 * @param limit - Maximum number of chats to return (default: 50)
 * @param offset - Number of chats to skip for pagination (default: 0)
 * @returns Paginated results with chat data and metadata
 */
export const getChats = (
  messagesDatabase: Database,
  limit = 50,
  offset = 0,
): PaginatedResult<Chat> => {
  // Count total chats
  const countSql = "SELECT COUNT(*) as total FROM chat";
  const countStmt = messagesDatabase.prepare(countSql);
  const { total } = countStmt.get() as { total: number };

  // Get paginated data
  const dataSql = `
    SELECT 
      c.ROWID,
      c.guid,
      c.style,
      c.state,
      c.account_id,
      c.chat_identifier,
      c.service_name,
      c.room_name,
      c.display_name,
      c.last_read_message_timestamp
    FROM chat c
    ORDER BY c.last_read_message_timestamp DESC
    LIMIT ? OFFSET ?
  `;

  const dataStmt = messagesDatabase.prepare(dataSql);
  const data = dataStmt.all(limit, offset) as Chat[];

  return {
    data,
    pagination: createPaginationMetadata(total, limit, offset),
  };
};

/**
 * Gets all contact handles (phone numbers and email addresses) from the database.
 * @param messagesDatabase - Database connection to use
 * @param limit - Maximum number of handles to return (default: 100)
 * @param offset - Number of handles to skip for pagination (default: 0)
 * @returns Paginated results with handle data and metadata
 */
export const getHandles = (
  messagesDatabase: Database,
  limit = 100,
  offset = 0,
): PaginatedResult<Handle> => {
  // Count total handles
  const countSql = "SELECT COUNT(*) as total FROM handle";
  const countStmt = messagesDatabase.prepare(countSql);
  const { total } = countStmt.get() as { total: number };

  // Get paginated data
  const dataSql = `
    SELECT 
      ROWID,
      id,
      country,
      service,
      uncanonicalized_id
    FROM handle
    ORDER BY id
    LIMIT ? OFFSET ?
  `;

  const dataStmt = messagesDatabase.prepare(dataSql);
  const data = dataStmt.all(limit, offset) as Handle[];

  return {
    data,
    pagination: createPaginationMetadata(total, limit, offset),
  };
};

/**
 * Gets messages from a specific chat conversation identified by its GUID.
 * @param messagesDatabase - Database connection to use
 * @param chatGuid - Unique identifier of the chat
 * @param limit - Maximum number of messages to return (default: 50)
 * @param offset - Number of messages to skip for pagination (default: 0)
 * @returns Paginated results with messages from the specified chat
 */
export const getMessagesFromChat = (
  messagesDatabase: Database,
  chatGuid: string,
  limit = 50,
  offset = 0,
): PaginatedResult<MessageWithHandle> => {
  // Count total messages in chat
  const countSql = `
    SELECT COUNT(*) as total
    FROM message m
    JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
    JOIN chat c ON cmj.chat_id = c.ROWID
    WHERE c.guid = ?
  `;
  const countStmt = messagesDatabase.prepare(countSql);
  const { total } = countStmt.get(chatGuid) as { total: number };

  // Get paginated data
  const dataSql = `
    SELECT 
      m.guid,
      m.text,
      m.attributedBody,
      m.handle_id,
      m.service,
      m.date/1000000000 + 978307200 as date,
      m.date_read/1000000000 + 978307200 as date_read,
      m.date_delivered/1000000000 + 978307200 as date_delivered,
      m.is_from_me,
      m.is_read,
      m.is_sent,
      m.is_delivered,
      m.cache_has_attachments,
      m.thread_originator_guid as reply_to_guid,
      h.id as handle_id_string,
      h.country as handle_country,
      h.service as handle_service
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
    JOIN chat c ON cmj.chat_id = c.ROWID
    WHERE c.guid = ?
    ORDER BY m.date DESC
    LIMIT ? OFFSET ?
  `;

  const dataStmt = messagesDatabase.prepare(dataSql);
  interface RawMessageRow extends MessageWithHandle {
    attributedBody?: Uint8Array | null;
  }
  const rawData = dataStmt.all(chatGuid, limit, offset) as RawMessageRow[];

  // Process the data to handle attributedBody decoding
  const data = rawData.map((row) => {
    const { attributedBody, ...message } = row;

    // If text is null/empty but attributedBody exists, decode it
    if (!message.text && attributedBody) {
      message.text = decodeAttributedBody(attributedBody);
    }

    return message;
  });

  return {
    data,
    pagination: createPaginationMetadata(total, limit, offset),
  };
};
