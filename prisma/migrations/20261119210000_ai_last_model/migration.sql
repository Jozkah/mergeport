-- The model that answered last, kept so automatic mode does not make the server swap models.
ALTER TABLE "AiSettings" ADD COLUMN "lastModel" TEXT;
