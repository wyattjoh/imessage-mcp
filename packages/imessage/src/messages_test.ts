import assert from "node:assert/strict";
import { Database } from "@db/sqlite";
import { searchMessages } from "./messages.ts";

type FixtureMessage = {
  guid: string;
  text: string | null;
  attributedBody: Uint8Array | null;
  date: number;
  handleId?: number;
};

const encodeAttributedBody = (text: string): Uint8Array => {
  return new TextEncoder().encode(`header${text}tailtailtail`);
};

const createDatabase = (): Database => {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE handle (
      id TEXT,
      country TEXT,
      service TEXT
    );

    CREATE TABLE message (
      guid TEXT,
      text TEXT,
      attributedBody BLOB,
      handle_id INTEGER,
      service TEXT,
      date INTEGER,
      date_read INTEGER,
      date_delivered INTEGER,
      is_from_me INTEGER,
      is_read INTEGER,
      is_sent INTEGER,
      is_delivered INTEGER,
      cache_has_attachments INTEGER,
      thread_originator_guid TEXT
    );
  `);
  database.exec(
    "INSERT INTO handle (id, country, service) VALUES (?, ?, ?)",
    "+15551234567",
    "US",
    "iMessage",
  );
  return database;
};

const insertMessage = (database: Database, message: FixtureMessage): void => {
  database.exec(
    `
      INSERT INTO message (
        guid,
        text,
        attributedBody,
        handle_id,
        service,
        date,
        date_read,
        date_delivered,
        is_from_me,
        is_read,
        is_sent,
        is_delivered,
        cache_has_attachments,
        thread_originator_guid
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    message.guid,
    message.text,
    message.attributedBody,
    message.handleId ?? 1,
    "iMessage",
    message.date,
    null,
    null,
    0,
    1,
    1,
    1,
    0,
    null,
  );
};

Deno.test("searches decoded attributedBody content", () => {
  const database = createDatabase();

  try {
    insertMessage(database, {
      guid: "plain-match",
      text: "Needle in the text column",
      attributedBody: null,
      date: 4,
    });
    insertMessage(database, {
      guid: "attributed-match",
      text: null,
      attributedBody: encodeAttributedBody("Needle in the attributed body"),
      date: 3,
    });
    insertMessage(database, {
      guid: "attributed-non-match",
      text: null,
      attributedBody: encodeAttributedBody("Different content"),
      date: 2,
    });
    insertMessage(database, {
      guid: "empty-message",
      text: null,
      attributedBody: null,
      date: 1,
    });

    const result = searchMessages(database, {
      query: "needle",
      limit: 10,
    });

    assert.deepEqual(
      result.data.map(({ guid, text }) => ({ guid, text })),
      [
        { guid: "plain-match", text: "Needle in the text column" },
        { guid: "attributed-match", text: "Needle in the attributed body" },
      ],
    );
    assert.deepEqual(result.pagination, {
      total: 2,
      limit: 10,
      offset: 0,
      hasMore: false,
      page: 1,
      totalPages: 1,
    });
  } finally {
    database.close();
  }
});

Deno.test("paginates after filtering decoded attributedBody content", () => {
  const database = createDatabase();

  try {
    insertMessage(database, {
      guid: "match-one",
      text: null,
      attributedBody: encodeAttributedBody("Match one"),
      date: 3,
    });
    insertMessage(database, {
      guid: "match-two",
      text: null,
      attributedBody: encodeAttributedBody("Match two"),
      date: 2,
    });
    insertMessage(database, {
      guid: "match-three",
      text: null,
      attributedBody: encodeAttributedBody("Match three"),
      date: 1,
    });
    insertMessage(database, {
      guid: "non-match",
      text: null,
      attributedBody: encodeAttributedBody("Other content"),
      date: 0,
    });

    const result = searchMessages(database, {
      query: "match",
      limit: 1,
      offset: 1,
    });

    assert.deepEqual(result.data.map(({ guid, text }) => ({ guid, text })), [
      { guid: "match-two", text: "Match two" },
    ]);
    assert.deepEqual(result.pagination, {
      total: 3,
      limit: 1,
      offset: 1,
      hasMore: true,
      page: 2,
      totalPages: 3,
    });
  } finally {
    database.close();
  }
});

Deno.test("keeps SQL pagination when no text query is provided", () => {
  const database = createDatabase();

  try {
    insertMessage(database, {
      guid: "newest",
      text: "Newest",
      attributedBody: null,
      date: 3,
    });
    insertMessage(database, {
      guid: "middle",
      text: "Middle",
      attributedBody: null,
      date: 2,
    });
    insertMessage(database, {
      guid: "oldest",
      text: "Oldest",
      attributedBody: null,
      date: 1,
    });

    const result = searchMessages(database, { limit: 1, offset: 1 });

    assert.deepEqual(result.data.map(({ guid }) => guid), ["middle"]);
    assert.deepEqual(result.pagination, {
      total: 3,
      limit: 1,
      offset: 1,
      hasMore: true,
      page: 2,
      totalPages: 3,
    });
  } finally {
    database.close();
  }
});
