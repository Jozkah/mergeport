-- AddForeignKey
ALTER TABLE "DeviceRepoMapping" ADD CONSTRAINT "DeviceRepoMapping_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
