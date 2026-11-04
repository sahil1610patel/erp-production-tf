variable "aws_region" {
  type    = string
  default = "ca-central-1"
  validation {
    condition     = var.aws_region == "ca-central-1"
    error_message = "This deployment is designed for Canada Central."
  }
}
variable "project_name" {
  type    = string
  default = "erp"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,14}$", var.project_name))
    error_message = "Use a lowercase project name of 2–15 characters."
  }
}
variable "environment" {
  type    = string
  default = "production"
  validation {
    condition     = contains(["development", "staging", "production"], var.environment)
    error_message = "Choose development, staging, or production."
  }
}
variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}
variable "origin_domain_name" {
  description = "Public DNS hostname pointing to the ALB, covered by origin_certificate_arn. CloudFront uses TLS to this hostname."
  type        = string
  validation {
    condition     = can(regex("^[a-zA-Z0-9][a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$", var.origin_domain_name))
    error_message = "Provide an owned DNS hostname without scheme or path."
  }
}
variable "origin_certificate_arn" {
  description = "Issued ACM certificate in ca-central-1 covering origin_domain_name."
  type        = string
  validation {
    condition     = can(regex("^arn:aws:acm:ca-central-1:", var.origin_certificate_arn))
    error_message = "The ALB certificate must be in ca-central-1."
  }
}
variable "origin_route53_zone_id" {
  description = "Optional public hosted zone ID. When null, create the origin ALIAS/CNAME in your DNS provider before API validation."
  type        = string
  default     = null
}
variable "app_secret_arn" {
  description = "Existing Secrets Manager secret in ca-central-1 containing jwtSecret (>=32 random bytes) and bootstrapPassword; never put its value in Terraform variables."
  type        = string
  validation {
    condition     = can(regex("^arn:aws:secretsmanager:ca-central-1:", var.app_secret_arn))
    error_message = "Supply a Canada Central Secrets Manager secret ARN."
  }
}
variable "app_secret_kms_key_arn" {
  description = "Customer-managed KMS key used by app_secret_arn, if any. Null for aws/secretsmanager."
  type        = string
  default     = null
}
variable "backend_release_key" {
  validation {
    condition     = can(regex("^[A-Za-z0-9._/-]+$", var.backend_release_key))
    error_message = "Use a simple S3 release path without shell metacharacters."
  }
  description = "Immutable S3 object key of the backend zip; upload to backend_bucket output before starting instances."
  type        = string
  default     = "releases/bootstrap/backend.zip"
}
variable "backend_release_sha256" {
  description = "SHA256 hex digest of backend zip; mandatory before desired_capacity is nonzero."
  type        = string
  default     = "0000000000000000000000000000000000000000000000000000000000000000"
  validation {
    condition     = can(regex("^[a-f0-9]{64}$", var.backend_release_sha256))
    error_message = "Provide a lowercase SHA256 hex digest."
  }
}
variable "desired_capacity" {
  description = "Use zero only for the first artifact upload/bootstrap, then set at least two in production."
  type        = number
  default     = 2
  validation {
    condition     = var.desired_capacity == floor(var.desired_capacity) && contains([0, 2, 3, 4, 5, 6], var.desired_capacity)
    error_message = "Choose zero for bootstrap or an integer from two through six."
  }
}
variable "instance_type" {
  type    = string
  default = "t3.small"
}
variable "node_version" {
  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.node_version))
    error_message = "Use an exact Node.js semver release."
  }
  type    = string
  default = "24.19.0"
}
variable "db_instance_class" {
  type    = string
  default = "db.m5.large"
}
variable "db_engine_version" {
  description = "Optional approved SQL Server Standard engine version. Null selects the regional default; pin the tested version for production releases."
  type        = string
  default     = null
}
variable "deletion_protection" {
  type    = bool
  default = true
}
variable "alarm_email" {
  type    = string
  default = null
}
variable "bootstrap_admin_email" {
  type    = string
  default = "admin@example.com"
}
variable "bootstrap_database" {
  description = "Temporary provisioning mode: permit RDS master secret and migrations. Disable after provisioning and supply a restricted runtime secret."
  type        = bool
  default     = false
}
variable "runtime_db_secret_arn" {
  description = "Dedicated SQL login secret with least-privilege ERP permissions, required for steady-state deployment."
  type        = string
  default     = null
  validation {
    condition     = var.runtime_db_secret_arn == null || can(regex("^arn:aws:secretsmanager:ca-central-1:", var.runtime_db_secret_arn))
    error_message = "Supply a Canada Central Secrets Manager secret ARN."
  }
}
variable "runtime_db_secret_kms_key_arn" {
  description = "Optional customer-managed KMS key encrypting the runtime database secret."
  type        = string
  default     = null
}
