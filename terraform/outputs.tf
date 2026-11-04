output "application_url" { value = "https://${aws_cloudfront_distribution.erp.domain_name}" }
output "cloudfront_distribution_id" { value = aws_cloudfront_distribution.erp.id }
output "frontend_bucket" { value = aws_s3_bucket.frontend.id }
output "backend_bucket" { value = aws_s3_bucket.backend.id }
output "autoscaling_group_name" { value = aws_autoscaling_group.app.name }
output "launch_template_id" { value = aws_launch_template.app.id }
output "alb_dns_name" { value = aws_lb.app.dns_name }
output "origin_dns_required" { value = "${var.origin_domain_name} -> ${aws_lb.app.dns_name}" }
output "database_endpoint" { value = aws_db_instance.erp.address }
output "database_secret_arn" {
  description = "Secret ARN only; retrieve values through authorized AWS SDK calls."
  value       = aws_db_instance.erp.master_user_secret[0].secret_arn
  sensitive   = true
}
output "application_log_group" { value = aws_cloudwatch_log_group.app.name }
output "alarm_topic_arn" { value = aws_sns_topic.alarms.arn }
