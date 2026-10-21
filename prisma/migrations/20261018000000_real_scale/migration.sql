-- Real scale connection: METTLER TOLEDO MT-SICS over a COM port, either on the
-- server PC (SERIAL) or on the station PC through the scale bridge (BRIDGE).

-- AlterTable
ALTER TABLE "Station" ADD COLUMN     "scalePort" TEXT,
ADD COLUMN     "scaleBaud" INTEGER NOT NULL DEFAULT 9600,
ADD COLUMN     "scaleFraming" TEXT NOT NULL DEFAULT '8N1',
ADD COLUMN     "bridgeKeyHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Station_bridgeKeyHash_key" ON "Station"("bridgeKeyHash");
