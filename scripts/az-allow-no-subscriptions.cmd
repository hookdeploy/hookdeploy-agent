@echo off
REM Wrapper so artifact-signing-cli can authenticate a Trusted Signing SP that
REM has no Azure subscription (Certificate Profile Signer only).
REM Forwards every az invocation; injects --allow-no-subscriptions on login.
setlocal
set "AZ_REAL=C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd"
if /I "%~1"=="login" (
  "%AZ_REAL%" %* --allow-no-subscriptions
) else (
  "%AZ_REAL%" %*
)
