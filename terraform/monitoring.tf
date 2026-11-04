resource "aws_cloudwatch_log_group" "app" {
  name              = "/erp/${local.name}/api"
  retention_in_days = 90
}
resource "aws_sns_topic" "alarms" { name = "${local.name}-alarms" }
resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == null ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}
resource "aws_cloudwatch_metric_alarm" "unhealthy" {
  alarm_name          = "${local.name}-unhealthy-targets"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "UnHealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  dimensions          = { LoadBalancer = aws_lb.app.arn_suffix, TargetGroup = aws_lb_target_group.app.arn_suffix }
  alarm_actions       = [aws_sns_topic.alarms.arn]
}
resource "aws_cloudwatch_metric_alarm" "api_errors" {
  alarm_name          = "${local.name}-api-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 10
  treat_missing_data  = "notBreaching"
  dimensions          = { LoadBalancer = aws_lb.app.arn_suffix }
  alarm_actions       = [aws_sns_topic.alarms.arn]
}
resource "aws_cloudwatch_metric_alarm" "db_storage" {
  alarm_name          = "${local.name}-database-storage"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "FreeStorageSpace"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Minimum"
  threshold           = 10737418240
  dimensions          = { DBInstanceIdentifier = aws_db_instance.erp.identifier }
  alarm_actions       = [aws_sns_topic.alarms.arn]
}
