ALTER TABLE "api_call_log" DROP CONSTRAINT "api_call_log_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "api_call_log" ADD CONSTRAINT "api_call_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;