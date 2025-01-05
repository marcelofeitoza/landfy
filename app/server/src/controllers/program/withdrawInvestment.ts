import { z } from "zod";
import {
	getInvestment,
	getInvestmentsByInvestor,
	getProperties,
	program,
} from "../../services/crowd-estate";
import { supabase } from "../../services/supabase";
import { updateSupabaseWithProperties } from "./listProperties";
import { updateSupabaseWithInvestments } from "./listInvestments";
import { redis, RedisKeys, RedisKeyTemplates } from "../../services/redis";
import { Investment } from "../../models/Investment";

const withdrawInvestmentSchema = z.object({
	investmentPda: z.string().min(32),
	investorPublicKey: z.string().min(32),
	propertyPda: z.string().min(32),
	txSignature: z.string().min(32),
});

export const handleWithdrawInvestment = async (body: any) => {
	const parseResult = withdrawInvestmentSchema.safeParse(body);
	if (!parseResult.success) {
		console.error("Invalid input parameters:", parseResult.error);
		throw { code: 400, message: "Invalid input parameters" };
	}
	const { investmentPda, txSignature, investorPublicKey, propertyPda } =
		parseResult.data;

	const cacheKeys = [
		RedisKeyTemplates.investmentsByInvestor(investorPublicKey),
		RedisKeyTemplates.investmentsDataByInvestor(investorPublicKey),
		RedisKeyTemplates.property(propertyPda),
		RedisKeys.Properties,
		RedisKeys.PropertiesAll,
	];
	console.log("Invalidating cache keys:", cacheKeys);
	await redis.invalidate(cacheKeys);

	try {
		console.log(
			`Fetching investment from Supabase with investmentPda: ${investmentPda}`
		);
		const { data: existingInvestment, error: fetchError } = await supabase
			.from("investments")
			.select("*")
			.eq("investment_pda", investmentPda)
			.single();

		if (fetchError || !existingInvestment) {
			console.error(
				"Investment not found in Supabase:",
				JSON.stringify(fetchError)
			);
			throw { code: 404, message: "Investment not found" };
		}
		console.log("Investment found in Supabase:", existingInvestment);

		console.log(`Deleting investment with investmentPda: ${investmentPda}`);
		const { data, error } = await supabase
			.from("investments")
			.delete()
			.eq("investment_pda", investmentPda)
			.select("*")
			.single();

		if (error || !data) {
			console.error(
				"Error deleting investment from Supabase:",
				JSON.stringify(error)
			);
			throw { code: 500, message: "Failed to withdraw investment" };
		}
		console.log("Investment successfully deleted from Supabase");

		console.log("Fetching updated properties from blockchain");
		const properties = await getProperties(undefined, undefined, true);
		console.log("Updating Supabase with updated properties");
		await updateSupabaseWithProperties(properties);

		console.log("Fetching updated investments for investor");
		const investments = await getInvestmentsByInvestor(investorPublicKey);
		console.log("Updating Supabase with updated investments");
		await updateSupabaseWithInvestments(investments);

		const cacheKey =
			RedisKeyTemplates.investmentsDataByInvestor(investorPublicKey);
		const cachedResult = await redis.get(cacheKey);
		if (cachedResult) {
			console.log("Updating cached investments data");
			const result = cachedResult;
			result.investmentsData = result.investmentsData.filter(
				(inv: Investment) => inv.publicKey !== investmentPda
			);
			let invested = 0;
			let returns = 0;

			result.investmentsData.forEach((investment: Investment) => {
				const property = properties.find(
					(p) => p.publicKey === investment.property
				);
				if (property) {
					invested += investment.amount * property.token_price_usdc;
					returns += investment.dividendsClaimed / 1e6;
				}
			});

			result.invested = invested;
			result.returns = returns;

			await redis.set(cacheKey, result);
			console.log(`Cache updated for key: ${cacheKey}`);
		}

		await redis.del(RedisKeys.Properties);
		console.log(`Deleted cache key: ${RedisKeys.Properties}`);

		return { message: "Investment withdrawn successfully" };
	} catch (err: any) {
		console.error("Error handling withdraw investment:", err);
		throw {
			code: err.code || 500,
			message: err.message || "Failed to withdraw investment",
		};
	}
};
