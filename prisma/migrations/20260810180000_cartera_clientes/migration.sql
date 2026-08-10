-- Cartera de clientes (v5 feature 30).
CREATE TABLE "ContactList" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactList_pkey" PRIMARY KEY ("id")
);

-- Clave compuesta: un contacto esta o no esta en la cartera, no hay mas estado. De paso
-- hace idempotente el alta automatica desde el worker del webhook.
CREATE TABLE "ContactListMember" (
    "contactListId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "addedById" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactListMember_pkey" PRIMARY KEY ("contactListId","contactId")
);

-- Acceso por ROL, no por usuario. Una cartera sin ninguna fila aqui es solo de admin
-- (default cerrado, ver src/contacts/access.ts).
CREATE TABLE "ContactListRole" (
    "contactListId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "canManage" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ContactListRole_pkey" PRIMARY KEY ("contactListId","roleId")
);

CREATE UNIQUE INDEX "ContactList_tenantId_name_key" ON "ContactList"("tenantId", "name");
CREATE INDEX "ContactList_tenantId_idx" ON "ContactList"("tenantId");
CREATE INDEX "ContactListMember_contactId_idx" ON "ContactListMember"("contactId");
CREATE INDEX "ContactListRole_roleId_idx" ON "ContactListRole"("roleId");

ALTER TABLE "ContactList" ADD CONSTRAINT "ContactList_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactList" ADD CONSTRAINT "ContactList_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContactListMember" ADD CONSTRAINT "ContactListMember_contactListId_fkey" FOREIGN KEY ("contactListId") REFERENCES "ContactList"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactListMember" ADD CONSTRAINT "ContactListMember_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactListMember" ADD CONSTRAINT "ContactListMember_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContactListRole" ADD CONSTRAINT "ContactListRole_contactListId_fkey" FOREIGN KEY ("contactListId") REFERENCES "ContactList"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactListRole" ADD CONSTRAINT "ContactListRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
