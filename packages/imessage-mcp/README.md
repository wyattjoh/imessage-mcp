# @wyattjoh/imessage-mcp

A Model Context Protocol (MCP) server that provides LLMs with read-only access to iMessage data on macOS. This package enables AI assistants to search messages, retrieve conversations, and access contact information.

## Installation

```bash
deno add @wyattjoh/imessage-mcp
```

## Features

- **6 MCP Tools** for comprehensive iMessage access:
  - `search_messages` - Full-text search with filters
  - `get_recent_messages` - Latest messages across all chats
  - `get_chats` - List conversations by activity
  - `get_handles` - All contacts/phone numbers
  - `get_messages_from_chat` - Messages from specific conversations
  - `search_contacts` - Search macOS Contacts by name

- **Pagination Support** - All tools support limit/offset pagination
- **Type-Safe** - Full TypeScript support with Zod schemas
- **Read-Only** - Safe, non-destructive access to iMessage data

## Usage

### As MCP Server

The package can be run directly as an MCP server:

```bash
deno run --allow-read --allow-env --allow-sys --allow-ffi jsr:@wyattjoh/imessage-mcp
```

### In Claude Desktop

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "imessage": {
      "command": "deno",
      "args": [
        "run",
        "--allow-read",
        "--allow-env",
        "--allow-sys",
        "--allow-ffi",
        "jsr:@wyattjoh/imessage-mcp"
      ]
    }
  }
}
```

To read a database snapshot or another SQLite file, grant access to `IMESSAGE_DB_PATH` and set it in the server environment:

```json
{
  "mcpServers": {
    "imessage": {
      "command": "deno",
      "args": [
        "run",
        "--allow-read",
        "--allow-env=IMESSAGE_DB_PATH",
        "--allow-sys",
        "--allow-ffi",
        "jsr:@wyattjoh/imessage-mcp"
      ],
      "env": {
        "IMESSAGE_DB_PATH": "/tmp/imessage-snapshot.sqlite"
      }
    }
  }
}
```

If access to the variable is not permitted, or it is empty or unset, the server uses `~/Library/Messages/chat.db` without prompting for environment access.

### Programmatic Usage

```typescript
import { startServer } from "@wyattjoh/imessage-mcp";

// Start the MCP server
await startServer();
```

## Permissions

The server requires the following Deno permissions:

- `--allow-read`: Access to iMessage and Contacts databases
- `--allow-env=IMESSAGE_DB_PATH`: Custom Messages database path (optional)
- `--allow-sys`: System information access
- `--allow-ffi`: SQLite native bindings

## Requirements

- macOS (uses system iMessage and Contacts databases)
- Deno 2.x or later
- Access to `~/Library/Messages/chat.db`, or to the file configured with `IMESSAGE_DB_PATH`
- Access to `~/Library/Application Support/AddressBook/`

## License

MIT
