-- Runs once, the first time the container's volume is created.
-- A separate database for `npm test`, so tests never touch your dev data.
CREATE DATABASE cybertrace_test;
