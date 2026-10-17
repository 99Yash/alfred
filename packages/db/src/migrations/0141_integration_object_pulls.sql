CREATE TABLE "integration_object_pulls" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"object_id" text NOT NULL,
	"pulled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "integration_object_pulls" ADD CONSTRAINT "integration_object_pulls_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_object_pulls" ADD CONSTRAINT "integration_object_pulls_object_id_integration_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."integration_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_object_pulls_object_idx" ON "integration_object_pulls" USING btree ("object_id");