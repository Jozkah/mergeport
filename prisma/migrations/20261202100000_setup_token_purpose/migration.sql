-- A setup link either names the first server administrator ("setup") or signs the existing one in while email does not work ("recovery").
ALTER TABLE "SetupToken" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'setup';
