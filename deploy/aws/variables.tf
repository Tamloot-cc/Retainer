variable "region" {
  description = "AWS region to deploy into, e.g. eu-central-1."
  type        = string
}

variable "name" {
  description = "Prefix for every resource name. Function names start with it, and the GitHub deploy role is limited to resources named with it where AWS names them in ARNs. Unique per AWS account: IAM role names are account-wide, so a deployment in a second region needs a name of its own."
  type        = string
  default     = "retainer"

  # The RDS instance identifier is the strictest use: a letter first, no
  # dash at the end and no two dashes in a row.
  validation {
    condition = (
      length(var.name) >= 2 && length(var.name) <= 31 &&
      can(regex("^[a-z]([a-z0-9]|-[a-z0-9])*$", var.name))
    )
    error_message = "Use 2-31 lowercase letters, digits and single dashes, starting with a letter and not ending with a dash."
  }
}

variable "tags" {
  description = "Extra tags for every resource. Application and ManagedBy are set by this deployment."
  type        = map(string)
  default     = {}

  validation {
    condition     = !contains(keys(var.tags), "Application") && !contains(keys(var.tags), "ManagedBy")
    error_message = "Leave Application and ManagedBy out of tags: Application is always name, which the GitHub deploy role's network access depends on."
  }
}

variable "package_path" {
  description = "Lambda package built by build.sh. Used only when the functions are created; deploy.sh ships later versions."
  type        = string
  default     = ".build/retainer.zip"
}

# ─── Domain ──────────────────────────────────────────────────────────────────

variable "domain_name" {
  description = "Custom domain, e.g. retainer.example.com. Leave null to use the API Gateway URL."
  type        = string
  default     = null
}

variable "domain_certificate_validated" {
  description = "Set to true once the certificate's DNS validation record (output dns_records) exists and ACM shows the certificate as issued. Attaches the domain and makes it the public origin."
  type        = bool
  default     = false
}

# ─── Database ────────────────────────────────────────────────────────────────

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_engine_version" {
  description = "PostgreSQL major version."
  type        = string
  default     = "18"
}

variable "db_allocated_storage_gb" {
  description = "Initial storage in GB; storage autoscaling may grow it to db_max_allocated_storage_gb."
  type        = number
  default     = 20
}

variable "db_max_allocated_storage_gb" {
  description = "Upper bound for storage autoscaling, in GB."
  type        = number
  default     = 100
}

variable "db_backup_retention_days" {
  description = "Days of automated backups (point-in-time recovery window)."
  type        = number
  default     = 14
}

variable "db_multi_az" {
  description = "Run a standby in a second availability zone. Doubles the database cost."
  type        = bool
  default     = false
}

variable "db_deletion_protection" {
  description = "Refuse to delete the database. Set to false and apply before terraform destroy."
  type        = bool
  default     = true
}

# ─── Functions and API ───────────────────────────────────────────────────────

variable "api_reserved_concurrency" {
  description = "Most API function instances at once. Each holds up to api_db_pool_max database connections, so keep the product under the database's connection limit."
  type        = number
  default     = 10
}

variable "api_db_pool_max" {
  description = "Database connections per API function instance."
  type        = number
  default     = 2
}

variable "api_memory_mb" {
  description = "Memory for the API function; CPU scales with it."
  type        = number
  default     = 1024
}

variable "api_throttle_rate" {
  description = "Steady-state requests per second API Gateway accepts."
  type        = number
  default     = 25
}

variable "api_throttle_burst" {
  description = "Burst of requests API Gateway accepts."
  type        = number
  default     = 50
}

variable "consolidate_interval_minutes" {
  description = "How often each workspace is consolidated (RETAINER_CONSOLIDATE_INTERVAL_MINUTES)."
  type        = number
  default     = 60
}

variable "consolidate_schedule" {
  description = "How often the consolidate function looks for due workspaces."
  type        = string
  default     = "rate(15 minutes)"
}

variable "log_level" {
  description = "Server log level: debug, info, warn or error."
  type        = string
  default     = "info"
}

variable "log_retention_days" {
  description = "Days to keep function and access logs."
  type        = number
  default     = 30
}

# ─── Accounts (docs/aws.md, Accounts) ────────────────────────────────────────

variable "google_client_id" {
  description = "Google OAuth client ID people sign in with. Setting it, with google_client_secret, turns on accounts mode: the control function, /account, and a NAT gateway for it (about $40 a month). Null keeps key mode."
  type        = string
  default     = null
}

variable "google_client_secret" {
  description = "The Google OAuth client's secret. Set it in terraform.tfvars (gitignored) or TF_VAR_google_client_secret, never in a committed file."
  type        = string
  default     = null
  sensitive   = true

  validation {
    condition     = (var.google_client_secret == null) == (var.google_client_id == null)
    error_message = "Set google_client_id and google_client_secret together, or neither."
  }
}

variable "control_reserved_concurrency" {
  description = "Most control function instances at once. Each holds up to twice control_db_pool_max database connections."
  type        = number
  default     = 5
}

variable "control_db_pool_max" {
  description = "Database connections per control function instance, for each of its two pools (account routes, and Better Auth)."
  type        = number
  default     = 1
}

# ─── Operations ──────────────────────────────────────────────────────────────

variable "alarm_email" {
  description = "Email for CloudWatch alarms. AWS sends a confirmation link first. Null creates the alarms and topic without a subscriber."
  type        = string
  default     = null
}

variable "github_repository" {
  description = "owner/repo whose Deploy to AWS workflow may apply this stack and ship code (assume the deploy role). Null creates no role."
  type        = string
  default     = null
}

variable "github_subject_prefix" {
  description = "The repository part of the OIDC subject GitHub signs for its jobs. Null means repo:<github_repository>. A repository with immutable subject claims uses repo:<owner>@<owner-id>/<repo>@<repo-id>: see docs/aws.md."
  type        = string
  default     = null
}

variable "state_bucket" {
  description = "S3 bucket of this deployment's Terraform state, which the GitHub deploy role may read and write. Null means the one state-bucket.sh creates."
  type        = string
  default     = null
}

variable "state_key" {
  description = "Key of this deployment's Terraform state in state_bucket. Null means the one state-bucket.sh prints: <name>/<region>/terraform.tfstate."
  type        = string
  default     = null
}
