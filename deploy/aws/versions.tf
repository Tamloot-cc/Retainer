terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6"
    }
  }

  # Partial configuration: bucket, key and region come from backend.hcl
  # (see backend.hcl.example), so no deployment's values live in the repo.
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    # Application is always `name`: the GitHub deploy role's network access
    # depends on it (github.tf).
    tags = merge(var.tags, { Application = var.name, ManagedBy = "terraform" })
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
