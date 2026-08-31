<!-- version: 2.57.2 -->
This update corrects the remaining balance shown for loans that carry interest. Loan payments always accepted a free amount, but the balance on the loan card was read from the original repayment plan, so an extra repayment did not lower it and a smaller payment quietly counted as a full installment. The balance now follows the money you actually booked: pay more and it drops by exactly that much, pay less and it honestly stays higher. Households that always pay the planned installment will see the same figures as before.

A loan that is fully repaid ahead of schedule is now marked as paid immediately, and no further installments are offered - the interest that the plan still projected is not owed after an early payoff.

The update needs nothing from you and applies no database change; the corrected figures appear as soon as Yuvomi restarts.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.57.2
