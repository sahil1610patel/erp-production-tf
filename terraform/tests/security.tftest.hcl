# Mocked plans verify policy and topology, without AWS credentials or deployment.
mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["ca-central-1a", "ca-central-1b"] }
  }
  mock_data "aws_ami" { defaults = { id = "ami-0123456789abcdef0" } }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ca-central-1:123456789012:loadbalancer/app/erp-test/0123456789abcdef" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ca-central-1:123456789012:targetgroup/erp-test/0123456789abcdef" }
  }
  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ca-central-1:123456789012:listener/app/erp-test/0123456789abcdef/0123456789abcdef" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:ca-central-1:123456789012:erp-test" }
  }
  mock_resource "aws_launch_template" {
    defaults = { id = "lt-0123456789abcdef0", latest_version = 1 }
  }
  mock_resource "aws_db_instance" {
    defaults = { master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:ca-central-1:123456789012:secret:erp-master-test", kms_key_id = "test", secret_status = "active" }] }
  }
}
mock_provider "aws" { alias = "global" }

variables {
  origin_domain_name     = "origin.erp.example.com"
  origin_certificate_arn = "arn:aws:acm:ca-central-1:123456789012:certificate/test"
  app_secret_arn         = "arn:aws:secretsmanager:ca-central-1:123456789012:secret:erp-app-test"
  runtime_db_secret_arn  = "arn:aws:secretsmanager:ca-central-1:123456789012:secret:erp-runtime-test"
  desired_capacity       = 2
  backend_release_sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}

run "runtime_security" {
  command = apply
  assert {
    condition     = length(aws_subnet.public) == 2 && length(aws_subnet.app) == 2 && length(aws_subnet.database) == 2 && length(aws_nat_gateway.main) == 2
    error_message = "Each tier needs two AZ subnets and applications need two NAT gateways."
  }
  assert {
    condition     = aws_db_instance.erp.multi_az && aws_db_instance.erp.storage_encrypted && !aws_db_instance.erp.publicly_accessible && aws_db_instance.erp.deletion_protection && !aws_db_instance.erp.skip_final_snapshot
    error_message = "The production database must be private, encrypted, Multi-AZ and protected."
  }
  assert {
    condition     = aws_db_instance.erp.manage_master_user_password && aws_db_instance.erp.backup_retention_period >= 35
    error_message = "RDS must manage the master secret and retain backups."
  }
  assert {
    condition     = length(local.database_secret_arns) == 1 && local.database_secret_arns[0] == var.runtime_db_secret_arn && !var.bootstrap_database
    error_message = "Steady state may access only the dedicated runtime database secret."
  }
  assert {
    condition     = length(local.secret_kms_keys) == 0 && alltrue([for s in jsondecode(aws_iam_role_policy.application.policy).Statement : !contains(s.Action, "secretsmanager:GetSecretValue") || s.Resource == concat([var.app_secret_arn], [var.runtime_db_secret_arn])])
    error_message = "Runtime IAM must scope secret access to application and runtime credentials only."
  }
  assert {
    condition     = aws_launch_template.app.metadata_options[0].http_tokens == "required" && aws_autoscaling_group.app.min_size == 2
    error_message = "Require IMDSv2 and at least two running instances."
  }
  assert {
    condition     = aws_lb_target_group.app.health_check[0].path == "/health"
    error_message = "A database outage must not trigger instance replacement storms."
  }
  assert {
    condition     = alltrue([for b in aws_cloudfront_distribution.erp.ordered_cache_behavior : b.viewer_protocol_policy == "https-only"])
    error_message = "API edge behaviors must require HTTPS."
  }
}

run "reject_missing_runtime_identity" {
  command = plan
  variables { runtime_db_secret_arn = null }
  expect_failures = [aws_launch_template.app]
}

run "reject_unverified_artifact" {
  command = plan
  variables { backend_release_sha256 = "0000000000000000000000000000000000000000000000000000000000000000" }
  expect_failures = [aws_launch_template.app]
}

run "reject_invalid_capacity" {
  command = plan
  variables { desired_capacity = 1 }
  expect_failures = [var.desired_capacity]
}

run "reject_shell_injection" {
  command = plan
  variables { backend_release_key = "releases/$(id)/backend.zip" }
  expect_failures = [var.backend_release_key]
}
