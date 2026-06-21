CREATE TABLE "integration_object_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"object_id" text NOT NULL,
	"provider" text NOT NULL,
	"key_kind" text NOT NULL,
	"key_value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "integration_object_relations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"object_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"relation" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "integration_objects" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"state_category" text NOT NULL,
	"native_state" text,
	"title" text,
	"url" text,
	"repo" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state_delivered_at" timestamp with time zone,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"supersedes_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "integration_object_keys" ADD CONSTRAINT "integration_object_keys_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_object_keys" ADD CONSTRAINT "integration_object_keys_object_id_integration_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."integration_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_object_relations" ADD CONSTRAINT "integration_object_relations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_object_relations" ADD CONSTRAINT "integration_object_relations_object_id_integration_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."integration_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_object_relations" ADD CONSTRAINT "integration_object_relations_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_objects" ADD CONSTRAINT "integration_objects_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_object_keys_unique_idx" ON "integration_object_keys" USING btree ("user_id","provider","key_kind","key_value");--> statement-breakpoint
CREATE INDEX "integration_object_keys_object_idx" ON "integration_object_keys" USING btree ("object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_object_relations_unique_idx" ON "integration_object_relations" USING btree ("user_id","object_id","entity_id","relation");--> statement-breakpoint
CREATE INDEX "integration_object_relations_object_idx" ON "integration_object_relations" USING btree ("user_id","object_id");--> statement-breakpoint
CREATE INDEX "integration_object_relations_entity_idx" ON "integration_object_relations" USING btree ("user_id","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_objects_identity_idx" ON "integration_objects" USING btree ("user_id","provider","kind","external_id");--> statement-breakpoint
CREATE INDEX "integration_objects_kind_idx" ON "integration_objects" USING btree ("user_id","provider","kind");--> statement-breakpoint
CREATE INDEX "integration_objects_state_idx" ON "integration_objects" USING btree ("user_id","state_category");