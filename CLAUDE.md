# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

This is a Deno workspace monorepo with two packages:

- `packages/imessage` - Core library for iMessage database access
- `packages/imessage-mcp` - MCP server implementation

### Root Commands (affects all packages)

```bash
# Cache dependencies for all packages
deno cache packages/*/mod.ts

# Code quality (runs on all packages)
deno task fmt     # Format all code
deno task lint    # Lint all packages
deno task check   # Type check all TypeScript files

# Run tests
deno task test

# Publish packages to JSR (CI/CD)
deno publish
```

### Package-Specific Commands

```bash
# Run the MCP server
cd packages/imessage-mcp
deno run --allow-read --allow-env --allow-sys --allow-ffi mod.ts

# Development with file watching
cd packages/imessage-mcp
deno run --allow-read --allow-env --allow-sys --allow-ffi --watch mod.ts

# Test the core library
cd packages/imessage
deno test --allow-read --allow-env --allow-ffi --allow-sys=homedir
```

## Architecture Overview

This monorepo contains a Model Context Protocol (MCP) server and core library that provide read-only access to the macOS iMessage database. The codebase follows functional programming principles with no classes.

### Package Structure

1. **@wyattjoh/imessage** (`packages/imessage/`)
   - Core library for iMessage database access
   - Database operations, type definitions, and utilities
   - No MCP dependencies - can be used standalone

2. **@wyattjoh/imessage-mcp** (`packages/imessage-mcp/`)
   - MCP server implementation
   - Imports and uses the core library
   - Provides LLM-accessible tools

### Core Components

1. **MCP Server Layer** (`packages/imessage-mcp/src/index.ts`)
   - Creates MCP server instance using `@modelcontextprotocol/sdk`
   - Defines 6 tools with Zod schemas for validation
   - Uses StdioServerTransport for communication
   - Lazy database initialization pattern

2. **Messages Database Layer** (`packages/imessage/src/messages.ts`)
   - Pure functions for all database operations
   - Direct SQLite access to `~/Library/Messages/chat.db`
   - Handles Apple's timestamp format (Core Data epoch: nanoseconds since 2001-01-01)
   - All queries are read-only with parameterized SQL
   - Implements pagination with metadata for all queries

3. **Contacts Integration** (`packages/imessage/src/contacts.ts`)
   - Direct SQLite access to `~/Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb`
   - Searches multiple AddressBook databases for comprehensive results
   - Phone number normalization (adds +1 prefix for 10-digit US numbers)
   - Returns both phone numbers and email addresses as potential iMessage handles

4. **Type System** (`packages/imessage/src/types.ts`)
   - Interfaces matching iMessage database schema
   - `MessageWithHandle` extends `Message` with denormalized handle data
   - All nullable fields use `T | undefined` pattern
   - `PaginatedResult<T>` wrapper for all paginated responses

### Key Technical Details

- **Timestamp Conversion**: Apple stores timestamps as nanoseconds since 2001-01-01. Conversion formula: `date/1000000000 + 978307200`
- **Database Paths**:
  - Messages: `~/Library/Messages/chat.db`
  - Contacts: `~/Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb`
- **Functional Patterns**: All database functions are pure, taking `Database` as first parameter
- **Error Handling**: Try-catch blocks in MCP tool handlers return error messages as text content
- **Pagination**: All tools support limit/offset pagination and return hasMore flag for complete data retrieval

### MCP Tools

1. `search_messages` - Full-text search with date/contact filters
2. `get_recent_messages` - Latest messages across all chats
3. `get_chats` - List conversations ordered by last activity
4. `get_handles` - All contacts/phone numbers
5. `get_messages_from_chat` - Messages from specific chat GUID
6. `search_contacts` - Search macOS Contacts by name, returns phone/email handles

### Important Pagination Note

All tools return paginated results. When performing analysis or summaries, ALWAYS check the `hasMore` field in the pagination metadata and continue fetching until `hasMore` is false to ensure complete data.

## iMessage Database Schema Notes

- `message` table: Core message data
- `handle` table: Contact information (phone/email)
- `chat` table: Conversation metadata
- `chat_message_join` table: Links messages to chats
- Boolean fields stored as integers (0/1)
- GUIDs are unique identifiers for messages and chats

## Repository Management

- Always use `deno task fmt`, `deno task lint`, and `deno task check` after modifying or creating code to ensure that it's correct.
- When making changes to the available tools, ensure you always update the README.md with the relevant changes.
