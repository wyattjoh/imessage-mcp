import { Database } from "@db/sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ContactInfo, PaginatedResult } from "./types.ts";

/**
 * Internal interface for the JOIN query results.
 * Each row represents a single contact handle (phone or email).
 */
interface ContactHandleRow {
  firstName: string | null;
  lastName: string | null;
  organization: string | null;
  handle: string;
  handle_type: "phone" | "email";
}

/**
 * Opens all available AddressBook databases on the system.
 * Searches for AddressBook database files in the macOS AddressBook Sources directory.
 * @returns Array of Database instances for each available AddressBook
 */
export function openContactsDatabases(): Database[] {
  const databases: Database[] = [];
  const addressBookBasePath = join(
    homedir(),
    "Library",
    "Application Support",
    "AddressBook",
    "Sources",
  );

  try {
    // Find all AddressBook database files
    const sourcesDirs = [];
    for (const entry of Deno.readDirSync(addressBookBasePath)) {
      if (entry.isDirectory) {
        sourcesDirs.push(entry.name);
      }
    }

    // Open each AddressBook database
    for (const sourceDir of sourcesDirs) {
      const dbPath = join(
        addressBookBasePath,
        sourceDir,
        "AddressBook-v22.abcddb",
      );

      try {
        if (!Deno.statSync(dbPath).isFile) {
          continue;
        }
      } catch {
        // Database file doesn't exist
        continue;
      }

      const db = new Database(dbPath, { readonly: true });
      databases.push(db);
    }

    return databases;
  } catch (error) {
    console.error("Error opening AddressBook databases:", error);
    return databases;
  }
}

/**
 * Builds the WHERE clause and parameters for contact search queries.
 */
function buildWhereClause(
  firstName: string,
  lastName: string | undefined,
): { whereClause: string; params: string[] } {
  if (firstName === "" && !lastName) {
    // Return all contacts with at least one name field
    return {
      whereClause:
        "(r.ZFIRSTNAME IS NOT NULL OR r.ZLASTNAME IS NOT NULL OR r.ZORGANIZATION IS NOT NULL)",
      params: [],
    };
  }

  if (lastName) {
    // Search for both first and last name
    const firstNamePattern = `%${firstName}%`;
    const lastNamePattern = `%${lastName}%`;
    return {
      whereClause: `
        (r.ZFIRSTNAME LIKE ? AND r.ZLASTNAME LIKE ?)
        AND (r.ZFIRSTNAME IS NOT NULL OR r.ZLASTNAME IS NOT NULL OR r.ZORGANIZATION IS NOT NULL)
      `,
      params: [firstNamePattern, lastNamePattern],
    };
  }

  // Search by first name across all name fields
  const searchPattern = `%${firstName}%`;
  return {
    whereClause: `
      (r.ZFIRSTNAME LIKE ? OR r.ZLASTNAME LIKE ? OR r.ZORGANIZATION LIKE ? OR r.ZNICKNAME LIKE ?)
      AND (r.ZFIRSTNAME IS NOT NULL OR r.ZLASTNAME IS NOT NULL OR r.ZORGANIZATION IS NOT NULL)
    `,
    params: [searchPattern, searchPattern, searchPattern, searchPattern],
  };
}

/**
 * Counts total contact handles (phones + emails) matching the search criteria.
 */
function countContactHandles(
  db: Database,
  firstName: string,
  lastName: string | undefined,
): number {
  const { whereClause, params } = buildWhereClause(firstName, lastName);

  const countQuery = `
    SELECT COUNT(*) as total FROM (
      SELECT 1
      FROM ZABCDRECORD r
      INNER JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
      WHERE ${whereClause}
      AND p.ZFULLNUMBER IS NOT NULL

      UNION ALL

      SELECT 1
      FROM ZABCDRECORD r
      INNER JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK
      WHERE ${whereClause}
      AND e.ZADDRESS IS NOT NULL
    )
  `;

  // Parameters are used twice (once for phones, once for emails)
  const allParams = [...params, ...params];
  const result = db.prepare(countQuery).get(...allParams) as { total: number };
  return result.total;
}

/**
 * Fetches contact handles (phones + emails) with SQL-level pagination.
 * Uses a UNION query to fetch both phones and emails in a single query.
 */
function fetchContactHandles(
  db: Database,
  firstName: string,
  lastName: string | undefined,
  limit: number,
  offset: number,
): ContactHandleRow[] {
  const { whereClause, params } = buildWhereClause(firstName, lastName);

  const dataQuery = `
    SELECT
      r.ZFIRSTNAME as firstName,
      r.ZLASTNAME as lastName,
      r.ZORGANIZATION as organization,
      p.ZFULLNUMBER as handle,
      'phone' as handle_type
    FROM ZABCDRECORD r
    INNER JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
    WHERE ${whereClause}
    AND p.ZFULLNUMBER IS NOT NULL

    UNION ALL

    SELECT
      r.ZFIRSTNAME as firstName,
      r.ZLASTNAME as lastName,
      r.ZORGANIZATION as organization,
      e.ZADDRESS as handle,
      'email' as handle_type
    FROM ZABCDRECORD r
    INNER JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK
    WHERE ${whereClause}
    AND e.ZADDRESS IS NOT NULL

    ORDER BY lastName, firstName, handle
    LIMIT ? OFFSET ?
  `;

  // Parameters: WHERE params (x2 for UNION), then LIMIT, OFFSET
  const allParams = [...params, ...params, limit, offset];
  return db.prepare(dataQuery).all(...allParams) as ContactHandleRow[];
}

/**
 * Searches across multiple AddressBook databases with proper pagination.
 * Handles offset consumption and result aggregation across databases.
 */
function searchContactHandlesAcrossDatabases(
  databases: Database[],
  firstName: string,
  lastName: string | undefined,
  limit: number,
  offset: number,
): { rows: ContactHandleRow[]; total: number } {
  let totalAcrossDbs = 0;
  let remainingOffset = offset;
  let remainingLimit = limit;
  const results: ContactHandleRow[] = [];

  for (const db of databases) {
    try {
      // Get count for this database
      const dbCount = countContactHandles(db, firstName, lastName);
      totalAcrossDbs += dbCount;

      // Skip this database entirely if offset exceeds its count
      if (remainingOffset >= dbCount) {
        remainingOffset -= dbCount;
        continue;
      }

      // We've collected enough results
      if (remainingLimit <= 0) {
        continue; // Still need to count remaining databases for total
      }

      // Fetch data from this database
      const rows = fetchContactHandles(
        db,
        firstName,
        lastName,
        remainingLimit,
        remainingOffset,
      );

      results.push(...rows);
      remainingOffset = 0; // Offset consumed
      remainingLimit -= rows.length;
    } catch (error) {
      console.error("Error searching in database:", error);
      // Continue with other databases
    }
  }

  return { rows: results, total: totalAcrossDbs };
}

/**
 * Builds a full name from contact name parts.
 */
function buildFullName(
  firstName: string | null,
  lastName: string | null,
  organization: string | null,
): string {
  const nameParts: string[] = [];
  if (firstName) nameParts.push(firstName);
  if (lastName) nameParts.push(lastName);
  if (nameParts.length === 0 && organization) {
    nameParts.push(organization);
  }
  return nameParts.join(" ") || "Unknown";
}

/**
 * Normalize a phone number to the format used by iMessage handles.
 */
function normalizePhoneNumber(phone: string): string {
  // Remove all non-digit characters except +
  const cleaned = phone.replace(/[^\d+]/g, "");

  // If it starts with +, keep it as is
  if (cleaned.startsWith("+")) {
    return cleaned;
  }

  // If it's a 10-digit number, add +1 prefix
  if (cleaned.length === 10) {
    return `+1${cleaned}`;
  }

  // If it's 11 digits starting with 1, add + prefix
  if (cleaned.length === 11 && cleaned.startsWith("1")) {
    return `+${cleaned}`;
  }

  // Otherwise return as is
  return cleaned || phone;
}

/**
 * Transforms ContactHandleRow results into ContactInfo array.
 * Applies phone normalization and deduplication.
 */
function transformToContactInfo(rows: ContactHandleRow[]): ContactInfo[] {
  const seen = new Set<string>();
  const results: ContactInfo[] = [];

  for (const row of rows) {
    const name = buildFullName(row.firstName, row.lastName, row.organization);

    // Normalize phone numbers, keep emails as-is
    const handle = row.handle_type === "phone"
      ? normalizePhoneNumber(row.handle)
      : row.handle;

    // Skip empty handles
    if (!handle) {
      continue;
    }

    // Deduplicate by name + handle
    const key = `${name}|${handle}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    results.push({ name, phone: handle });
  }

  return results;
}

/**
 * Searches for contacts by name in the macOS AddressBook and returns their phone numbers and email addresses.
 * Phone numbers are normalized to match iMessage handle format (e.g., +1 prefix for US numbers).
 * @param contactsDatabases - Array of AddressBook database connections
 * @param firstName - First name to search for (searches across all name fields if lastName not provided)
 * @param lastName - Optional last name for more specific search
 * @param limit - Maximum number of results to return (default: 50)
 * @param offset - Number of results to skip for pagination (default: 0)
 * @returns Paginated results with contact names and their phone/email handles
 */
export function searchContactsByName(
  contactsDatabases: Database[],
  firstName: string,
  lastName: string | undefined,
  limit = 50,
  offset = 0,
): PaginatedResult<ContactInfo> {
  try {
    // Fetch handles with SQL-level pagination across all databases
    const { rows, total } = searchContactHandlesAcrossDatabases(
      contactsDatabases,
      firstName,
      lastName,
      limit,
      offset,
    );

    // Transform to ContactInfo with normalization and deduplication
    const data = transformToContactInfo(rows);

    // Calculate pagination metadata
    const hasMore = offset + limit < total;
    const page = Math.floor(offset / limit) + 1;
    const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;

    return {
      data,
      pagination: {
        total,
        limit,
        offset,
        hasMore,
        page,
        totalPages,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to search contacts: ${errorMessage}`);
  }
}
