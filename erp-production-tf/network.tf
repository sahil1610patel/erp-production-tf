# 1. Custom VPC with DNS Hostnames & Support Enabled
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.project_name}-vpc" }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.project_name}-igw" }
}

# 2. Public Subnets (2 AZs)
resource "aws_subnet" "public_az1" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.project_name}-public-az1" }
}

resource "aws_subnet" "public_az2" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.2.0/24"
  availability_zone       = "${var.aws_region}b"
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.project_name}-public-az2" }
}

# 3. Private App Subnets (2 AZs for EC2 & Interface Endpoints)
resource "aws_subnet" "private_app_az1" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.10.0/24"
  availability_zone = "${var.aws_region}a"
  tags              = { Name = "${var.project_name}-private-app-az1" }
}

resource "aws_subnet" "private_app_az2" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.20.0/24"
  availability_zone = "${var.aws_region}b"
  tags              = { Name = "${var.project_name}-private-app-az2" }
}

# 4. Private DB Subnets (2 AZs isolated strictly for Multi-AZ RDS)
resource "aws_subnet" "private_db_az1" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.100.0/24"
  availability_zone = "${var.aws_region}a"
  tags              = { Name = "${var.project_name}-private-db-az1" }
}

resource "aws_subnet" "private_db_az2" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.200.0/24"
  availability_zone = "${var.aws_region}b"
  tags              = { Name = "${var.project_name}-private-db-az2" }
}

# 5. Two High-Availability NAT Gateways (One in Each AZ)
resource "aws_eip" "nat_eip_az1" {
  domain = "vpc"
  tags   = { Name = "${var.project_name}-nat-eip-az1" }
}

resource "aws_eip" "nat_eip_az2" {
  domain = "vpc"
  tags   = { Name = "${var.project_name}-nat-eip-az2" }
}

resource "aws_nat_gateway" "nat_az1" {
  allocation_id = aws_eip.nat_eip_az1.id
  subnet_id     = aws_subnet.public_az1.id
  tags          = { Name = "${var.project_name}-nat-az1" }
  depends_on    = [aws_internet_gateway.igw]
}

resource "aws_nat_gateway" "nat_az2" {
  allocation_id = aws_eip.nat_eip_az2.id
  subnet_id     = aws_subnet.public_az2.id
  tags          = { Name = "${var.project_name}-nat-az2" }
  depends_on    = [aws_internet_gateway.igw]
}

# 6. Route Tables (Public + 2 Independent AZ Private Route Tables)
resource "aws_route_table" "public_rt" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
  tags = { Name = "${var.project_name}-public-rt" }
}

resource "aws_route_table_association" "pub_az1" {
  subnet_id      = aws_subnet.public_az1.id
  route_table_id = aws_route_table.public_rt.id
}

resource "aws_route_table_association" "pub_az2" {
  subnet_id      = aws_subnet.public_az2.id
  route_table_id = aws_route_table.public_rt.id
}

# Private Route Table AZ1 -> NAT Gateway AZ1
resource "aws_route_table" "private_rt_az1" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.nat_az1.id
  }
  tags = { Name = "${var.project_name}-private-rt-az1" }
}

resource "aws_route_table_association" "priv_app_az1" {
  subnet_id      = aws_subnet.private_app_az1.id
  route_table_id = aws_route_table.private_rt_az1.id
}

resource "aws_route_table_association" "priv_db_az1" {
  subnet_id      = aws_subnet.private_db_az1.id
  route_table_id = aws_route_table.private_rt_az1.id
}

# Private Route Table AZ2 -> NAT Gateway AZ2
resource "aws_route_table" "private_rt_az2" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.nat_az2.id
  }
  tags = { Name = "${var.project_name}-private-rt-az2" }
}

resource "aws_route_table_association" "priv_app_az2" {
  subnet_id      = aws_subnet.private_app_az2.id
  route_table_id = aws_route_table.private_rt_az2.id
}

resource "aws_route_table_association" "priv_db_az2" {
  subnet_id      = aws_subnet.private_db_az2.id
  route_table_id = aws_route_table.private_rt_az2.id
}

# 7. Security Groups (Explicit Inbound & Unrestricted Outbound)
resource "aws_security_group" "alb_sg" {
  name        = "${var.project_name}-alb-sg"
  description = "Allow HTTP inbound to ALB"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "ec2_sg" {
  name        = "${var.project_name}-ec2-sg"
  description = "Allow port 5000 from ALB and full outbound access"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 5000
    to_port         = 5000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb_sg.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "vpce_sg" {
  name        = "${var.project_name}-vpce-sg"
  description = "Allow HTTPS 443 from EC2 SG and VPC CIDR"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.ec2_sg.id]
    cidr_blocks     = [aws_vpc.main.cidr_block]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "rds_sg" {
  name        = "${var.project_name}-rds-sg"
  description = "Allow MSSQL 1433 from EC2 SG and 3343 for Multi-AZ Mirroring"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "MSSQL from EC2 Backend"
    from_port       = 1433
    to_port         = 1433
    protocol        = "tcp"
    security_groups = [aws_security_group.ec2_sg.id]
    cidr_blocks     = [aws_vpc.main.cidr_block]
  }

  ingress {
    description = "RDS SQL Server Multi-AZ internal mirroring TCP"
    from_port   = 3343
    to_port     = 3343
    protocol    = "tcp"
    self        = true
  }

  ingress {
    description = "RDS SQL Server Multi-AZ internal mirroring UDP"
    from_port   = 3343
    to_port     = 3343
    protocol    = "udp"
    self        = true
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# 8. Secrets Manager Interface VPC Endpoint in Private App Subnets
resource "aws_vpc_endpoint" "secretsmanager" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.secretsmanager"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.private_app_az1.id, aws_subnet.private_app_az2.id]
  security_group_ids  = [aws_security_group.vpce_sg.id]
  private_dns_enabled = true

  tags = { Name = "${var.project_name}-secretsmanager-vpce" }
}