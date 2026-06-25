export * as DatabaseDialect from "./dialect"

export type Dialect = "sqlite" | "postgres" | "mysql"

export function detect(): Dialect {
  const env = process.env.OPENCODE_DATABASE_DIALECT
  if (env === "postgres" || env === "postgresql" || env === "pg") return "postgres"
  if (env === "mysql" || env === "mariadb") return "mysql"
  return "sqlite"
}

export function isPostgres(dialect: Dialect): dialect is "postgres" {
  return dialect === "postgres"
}

export function isMySQL(dialect: Dialect): dialect is "mysql" {
  return dialect === "mysql"
}

export function isSQLite(dialect: Dialect): dialect is "sqlite" {
  return dialect === "sqlite"
}
